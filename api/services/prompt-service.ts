import { and, asc, eq, ne, sql } from "drizzle-orm";
import type { DatabaseClient } from "../db/client.js";
import {
  promptCategories,
  promptCategoryLinks,
  promptLibraries,
  prompts,
  type Prompt,
  type PromptLibrary,
} from "../db/schema.js";
import { ApiError } from "../http/errors.js";
import {
  defaultPromptCategories,
  defaultPrompts,
} from "../models/default-prompts.js";
import type {
  PromptCategoryCreateInput,
  PromptCategoryListQuery,
  PromptCategoryUpdateInput,
  PromptCreateInput,
  PromptLibraryCreateInput,
  PromptListQuery,
  PromptUpdateInput,
} from "../models/request-schemas.js";

type Transaction = Parameters<
  Parameters<DatabaseClient["db"]["transaction"]>[0]
>[0];
type Executor = DatabaseClient["db"] | Transaction;

// The Default library ships the system catalog from default-prompts.ts. The
// id matches the row that 0007_prompt_libraries.sql inserts; the key is what
// identifies it, so a database whose row was recreated still resolves.
export const DEFAULT_PROMPT_LIBRARY_ID = "prompt-library-default";
export const DEFAULT_PROMPT_LIBRARY_KEY = "default";
export const DEFAULT_PROMPT_LIBRARY_NAME = "Default";

export interface PromptWithCategories {
  prompt: Prompt;
  categoryIds: string[];
}

export interface PromptLibraryDeletion {
  library: PromptLibrary;
  deleted: { prompts: number; categories: number };
}

export class PromptService {
  private readonly db: DatabaseClient["db"];

  constructor(databaseClient: DatabaseClient) {
    this.db = databaseClient.db;
  }

  listLibraries() {
    return this.db
      .select()
      .from(promptLibraries)
      .orderBy(asc(promptLibraries.position), asc(promptLibraries.name))
      .all();
  }

  getLibrary(libraryId: string) {
    const library = this.db
      .select()
      .from(promptLibraries)
      .where(eq(promptLibraries.id, libraryId))
      .get();

    if (!library) {
      throw new ApiError(404, "not_found", "Prompt library not found");
    }

    return library;
  }

  getDefaultLibrary() {
    const library = this.findDefaultLibrary(this.db);
    if (!library) {
      throw new ApiError(
        500,
        "internal_error",
        "Default prompt library is missing",
      );
    }
    return library;
  }

  createLibrary(input: PromptLibraryCreateInput) {
    const name = this.validateLibraryName(input.name);
    this.ensureLibraryNameAvailable(name);
    return this.db
      .insert(promptLibraries)
      .values({ name, position: this.nextLibraryPosition() })
      .returning()
      .get();
  }

  renameLibrary(libraryId: string, name: string) {
    const library = this.getLibrary(libraryId);
    if (isDefaultLibrary(library)) {
      throw new ApiError(
        400,
        "invalid_request",
        "The Default prompt library cannot be renamed",
      );
    }
    const validName = this.validateLibraryName(name);
    this.ensureLibraryNameAvailable(validName, libraryId);
    return this.db
      .update(promptLibraries)
      .set({ name: validName })
      .where(eq(promptLibraries.id, libraryId))
      .returning()
      .get();
  }

  // Hard-deletes the library with every category, prompt, and link inside it.
  // Rows are deleted explicitly so the returned counts describe exactly what
  // went away, independent of the foreign-key cascade.
  deleteLibrary(libraryId: string): PromptLibraryDeletion {
    const library = this.getLibrary(libraryId);
    if (isDefaultLibrary(library)) {
      throw new ApiError(
        400,
        "invalid_request",
        "The Default prompt library cannot be deleted",
      );
    }

    const deleted = this.db.transaction((tx) => {
      const counts = {
        prompts: this.countRows(tx, prompts, prompts.libraryId, libraryId),
        categories: this.countRows(
          tx,
          promptCategories,
          promptCategories.libraryId,
          libraryId,
        ),
      };
      tx.delete(prompts).where(eq(prompts.libraryId, libraryId)).run();
      tx
        .delete(promptCategories)
        .where(eq(promptCategories.libraryId, libraryId))
        .run();
      tx.delete(promptLibraries).where(eq(promptLibraries.id, libraryId)).run();
      return counts;
    });

    return { library, deleted };
  }

  // Creates the Default library row when it is missing and fills it from the
  // shipped catalog when it holds nothing at all. Meant to run on every API
  // startup: one lookup and two counts when there is nothing to do.
  ensureDefaultLibrary() {
    return this.db.transaction((tx) => {
      const library = this.ensureDefaultLibraryRow(tx);
      const promptCount = this.countRows(
        tx,
        prompts,
        prompts.libraryId,
        library.id,
      );
      const categoryCount = this.countRows(
        tx,
        promptCategories,
        promptCategories.libraryId,
        library.id,
      );
      if (promptCount > 0 || categoryCount > 0) {
        return { seeded: false, library };
      }
      this.reconcileDefaults(tx, library.id, new Set<string>());
      return { seeded: true, library };
    });
  }

  listCategories(query: PromptCategoryListQuery = {}) {
    if (query.libraryId) {
      this.getLibrary(query.libraryId);
    }
    return this.db
      .select()
      .from(promptCategories)
      .where(
        query.libraryId
          ? eq(promptCategories.libraryId, query.libraryId)
          : undefined,
      )
      .orderBy(asc(promptCategories.position), asc(promptCategories.name))
      .all();
  }

  createCategory(input: PromptCategoryCreateInput) {
    const library = this.getLibrary(input.libraryId);
    this.ensureCategoryNameAvailable(library.id, input.name);
    return this.db
      .insert(promptCategories)
      .values({
        libraryId: library.id,
        name: input.name,
        description: input.description,
        position: this.nextCategoryPosition(library.id),
        metadata: input.metadata,
      })
      .returning()
      .get();
  }

  getCategory(categoryId: string) {
    const category = this.db
      .select()
      .from(promptCategories)
      .where(eq(promptCategories.id, categoryId))
      .get();

    if (!category) {
      throw new ApiError(404, "not_found", "Prompt category not found");
    }

    return category;
  }

  updateCategory(categoryId: string, input: PromptCategoryUpdateInput) {
    const category = this.getCategory(categoryId);
    if (input.name) {
      this.ensureCategoryNameAvailable(
        category.libraryId,
        input.name,
        categoryId,
      );
    }
    return this.db
      .update(promptCategories)
      .set(input)
      .where(eq(promptCategories.id, categoryId))
      .returning()
      .get();
  }

  deleteCategory(categoryId: string) {
    const category = this.getCategory(categoryId);
    this.db
      .delete(promptCategories)
      .where(eq(promptCategories.id, categoryId))
      .run();
    return category;
  }

  reorderCategory(categoryId: string, position: number) {
    const category = this.getCategory(categoryId);

    this.db.transaction((tx) => {
      const rows = tx
        .select({ id: promptCategories.id, position: promptCategories.position })
        .from(promptCategories)
        .where(eq(promptCategories.libraryId, category.libraryId))
        .orderBy(asc(promptCategories.position), asc(promptCategories.name))
        .all();

      const ordered = orderWithMovedId(
        rows.map((row) => row.id),
        categoryId,
        position,
      );

      for (const [index, id] of ordered.entries()) {
        if (rows.find((row) => row.id === id)?.position === index) {
          continue;
        }
        tx
          .update(promptCategories)
          .set({ position: index })
          .where(eq(promptCategories.id, id))
          .run();
      }
    });

    return this.getCategory(categoryId);
  }

  listPrompts(query: PromptListQuery = {}): PromptWithCategories[] {
    if (query.libraryId) {
      this.getLibrary(query.libraryId);
    }
    let rows = this.db
      .select()
      .from(prompts)
      .where(query.libraryId ? eq(prompts.libraryId, query.libraryId) : undefined)
      .orderBy(asc(prompts.position), asc(prompts.name))
      .all();

    const linksByPromptId = this.linksByPromptId(query.libraryId);

    if (query.categoryId) {
      this.getCategory(query.categoryId);
      rows = rows.filter((prompt) =>
        (linksByPromptId.get(prompt.id) ?? []).includes(query.categoryId!),
      );
    }

    if (query.q) {
      const needle = query.q.toLowerCase();
      rows = rows.filter(
        (prompt) =>
          prompt.name.toLowerCase().includes(needle) ||
          prompt.body.toLowerCase().includes(needle),
      );
    }

    return rows.map((prompt) => ({
      prompt,
      categoryIds: linksByPromptId.get(prompt.id) ?? [],
    }));
  }

  getPrompt(promptId: string): PromptWithCategories {
    const prompt = this.db
      .select()
      .from(prompts)
      .where(eq(prompts.id, promptId))
      .get();

    if (!prompt) {
      throw new ApiError(404, "not_found", "Prompt not found");
    }

    return { prompt, categoryIds: this.categoryIdsForPrompt(promptId) };
  }

  createPrompt(input: PromptCreateInput): PromptWithCategories {
    const library = this.getLibrary(input.libraryId);
    const categoryIds = this.resolveCategoryIds(input.categoryIds, library.id);
    const created = this.db.transaction((tx) => {
      const prompt = tx
        .insert(prompts)
        .values({
          libraryId: library.id,
          name: input.name,
          body: input.body,
          note: input.note,
          position: this.nextPromptPosition(library.id, tx),
          metadata: input.metadata,
        })
        .returning()
        .get();
      this.insertLinks(tx, prompt.id, categoryIds);
      return prompt;
    });

    return { prompt: created, categoryIds };
  }

  // `libraryId` is not part of the update input: a prompt stays in the
  // library it was created in, and its links may only point at categories of
  // that library.
  updatePrompt(promptId: string, input: PromptUpdateInput): PromptWithCategories {
    const existing = this.getPrompt(promptId);
    const { categoryIds, ...fields } = input;
    const resolvedCategoryIds =
      categoryIds === undefined
        ? undefined
        : this.resolveCategoryIds(categoryIds, existing.prompt.libraryId);

    const updated = this.db.transaction((tx) => {
      const prompt =
        Object.keys(fields).length > 0
          ? tx
              .update(prompts)
              .set(fields)
              .where(eq(prompts.id, promptId))
              .returning()
              .get()
          : tx.select().from(prompts).where(eq(prompts.id, promptId)).get()!;

      if (resolvedCategoryIds !== undefined) {
        tx
          .delete(promptCategoryLinks)
          .where(eq(promptCategoryLinks.promptId, promptId))
          .run();
        this.insertLinks(tx, promptId, resolvedCategoryIds);
      }

      return prompt;
    });

    return {
      prompt: updated,
      categoryIds: resolvedCategoryIds ?? this.categoryIdsForPrompt(promptId),
    };
  }

  deletePrompt(promptId: string): PromptWithCategories {
    const existing = this.getPrompt(promptId);
    this.db.delete(prompts).where(eq(prompts.id, promptId)).run();
    return existing;
  }

  // Prompts carry one order per library. A category view is a projection of
  // it, so reordering from inside a category still rewrites the library's
  // single list.
  reorderPrompt(promptId: string, position: number): PromptWithCategories {
    const { prompt: existing } = this.getPrompt(promptId);

    this.db.transaction((tx) => {
      const rows = tx
        .select({ id: prompts.id, position: prompts.position })
        .from(prompts)
        .where(eq(prompts.libraryId, existing.libraryId))
        .orderBy(asc(prompts.position), asc(prompts.name))
        .all();

      const ordered = orderWithMovedId(
        rows.map((row) => row.id),
        promptId,
        position,
      );

      for (const [index, id] of ordered.entries()) {
        if (rows.find((row) => row.id === id)?.position === index) {
          continue;
        }
        tx
          .update(prompts)
          .set({ position: index })
          .where(eq(prompts.id, id))
          .run();
      }
    });

    return this.getPrompt(promptId);
  }

  recordPromptUse(promptId: string): PromptWithCategories {
    this.getPrompt(promptId);
    const prompt = this.db
      .update(prompts)
      .set({
        usageCount: sql`${prompts.usageCount} + 1`,
        lastUsedAt: new Date(),
      })
      .where(eq(prompts.id, promptId))
      .returning()
      .get();

    return { prompt, categoryIds: this.categoryIdsForPrompt(promptId) };
  }

  // Reconciles the system-owned rows of the Default library to the shipped
  // catalog while preserving user-created prompts and categories in it.
  // Same-named user rows are adopted so databases created before a default
  // key was introduced do not get duplicates. Other libraries are never read
  // or written.
  restoreDefaults() {
    const restored = new Set<string>();

    const library = this.db.transaction((tx) => {
      const defaultLibrary = this.ensureDefaultLibraryRow(tx);
      this.reconcileDefaults(tx, defaultLibrary.id, restored);
      return defaultLibrary;
    });

    return {
      restored: [...restored],
      library,
      categories: this.listCategories({ libraryId: library.id }),
      prompts: this.listPrompts({ libraryId: library.id }),
    };
  }

  private reconcileDefaults(
    tx: Transaction,
    libraryId: string,
    restored: Set<string>,
  ) {
    const inLibrary = {
      prompts: eq(prompts.libraryId, libraryId),
      categories: eq(promptCategories.libraryId, libraryId),
    };
    const categoryKeys = new Set(
      defaultPromptCategories.map((seed) => seed.defaultKey),
    );
    const promptKeys = new Set(defaultPrompts.map((seed) => seed.defaultKey));

    for (const prompt of tx.select().from(prompts).where(inLibrary.prompts).all()) {
      if (prompt.defaultKey && !promptKeys.has(prompt.defaultKey)) {
        tx.delete(prompts).where(eq(prompts.id, prompt.id)).run();
        restored.add(`removed:prompt:${prompt.defaultKey}`);
      }
    }

    for (const category of tx
      .select()
      .from(promptCategories)
      .where(inLibrary.categories)
      .all()) {
      if (category.defaultKey && !categoryKeys.has(category.defaultKey)) {
        tx
          .delete(promptCategories)
          .where(eq(promptCategories.id, category.id))
          .run();
        restored.add(`removed:category:${category.defaultKey}`);
      }
    }

    const categoryIdsByDefaultKey = new Map<string, string>();

    for (const seed of defaultPromptCategories) {
      let category = tx
        .select()
        .from(promptCategories)
        .where(
          and(
            inLibrary.categories,
            eq(promptCategories.defaultKey, seed.defaultKey),
          ),
        )
        .get();
      const byName = tx
        .select()
        .from(promptCategories)
        .where(and(inLibrary.categories, eq(promptCategories.name, seed.name)))
        .get();

      if (category && byName && category.id !== byName.id) {
        // Preserve links from custom prompts before replacing an edited
        // system category with the user row that owns the canonical name.
        const oldLinks = tx
          .select()
          .from(promptCategoryLinks)
          .where(eq(promptCategoryLinks.categoryId, category.id))
          .all();
        const replacementLinks = tx
          .select()
          .from(promptCategoryLinks)
          .where(eq(promptCategoryLinks.categoryId, byName.id))
          .all();
        for (const link of oldLinks) {
          if (
            replacementLinks.some(
              (candidate) => candidate.promptId === link.promptId,
            )
          ) {
            continue;
          }
          tx.insert(promptCategoryLinks)
            .values({
              promptId: link.promptId,
              categoryId: byName.id,
              position: link.position,
            })
            .run();
        }
        tx
          .delete(promptCategories)
          .where(eq(promptCategories.id, category.id))
          .run();
        category = byName;
      }

      category ??= byName;
      if (!category) {
        category = tx
          .insert(promptCategories)
          .values({
            libraryId,
            name: seed.name,
            description: seed.description,
            position: seed.position,
            defaultKey: seed.defaultKey,
          })
          .returning()
          .get();
        restored.add(`category:${seed.defaultKey}`);
      } else if (
        category.name !== seed.name ||
        category.description !== seed.description ||
        category.position !== seed.position ||
        category.defaultKey !== seed.defaultKey
      ) {
        category = tx
          .update(promptCategories)
          .set({
            name: seed.name,
            description: seed.description,
            position: seed.position,
            defaultKey: seed.defaultKey,
          })
          .where(eq(promptCategories.id, category.id))
          .returning()
          .get();
        restored.add(`category:${seed.defaultKey}`);
      }

      categoryIdsByDefaultKey.set(seed.defaultKey, category.id);
    }

    for (const seed of defaultPrompts) {
      let prompt = tx
        .select()
        .from(prompts)
        .where(and(inLibrary.prompts, eq(prompts.defaultKey, seed.defaultKey)))
        .get();
      prompt ??= tx
        .select()
        .from(prompts)
        .where(and(inLibrary.prompts, eq(prompts.name, seed.name)))
        .orderBy(asc(prompts.position), asc(prompts.id))
        .get();

      if (!prompt) {
        prompt = tx
          .insert(prompts)
          .values({
            libraryId,
            name: seed.name,
            body: seed.body,
            note: seed.note,
            position: seed.position,
            defaultKey: seed.defaultKey,
          })
          .returning()
          .get();
        restored.add(`prompt:${seed.defaultKey}`);
      } else if (
        prompt.name !== seed.name ||
        prompt.body !== seed.body ||
        prompt.note !== seed.note ||
        prompt.position !== seed.position ||
        prompt.defaultKey !== seed.defaultKey
      ) {
        prompt = tx
          .update(prompts)
          .set({
            name: seed.name,
            body: seed.body,
            note: seed.note,
            position: seed.position,
            defaultKey: seed.defaultKey,
          })
          .where(eq(prompts.id, prompt.id))
          .returning()
          .get();
        restored.add(`prompt:${seed.defaultKey}`);
      }

      const categoryIds = seed.categoryDefaultKeys
        .map((key) => categoryIdsByDefaultKey.get(key))
        .filter((value): value is string => Boolean(value));
      const existingCategoryIds = tx
        .select({ categoryId: promptCategoryLinks.categoryId })
        .from(promptCategoryLinks)
        .where(eq(promptCategoryLinks.promptId, prompt.id))
        .orderBy(asc(promptCategoryLinks.position))
        .all()
        .map((link) => link.categoryId);
      if (
        existingCategoryIds.length !== categoryIds.length ||
        existingCategoryIds.some((id, index) => id !== categoryIds[index])
      ) {
        tx
          .delete(promptCategoryLinks)
          .where(eq(promptCategoryLinks.promptId, prompt.id))
          .run();
        this.insertLinks(tx, prompt.id, categoryIds);
        restored.add(`prompt:${seed.defaultKey}`);
      }
    }

    const orderedCategoryRows = tx
      .select()
      .from(promptCategories)
      .where(inLibrary.categories)
      .orderBy(asc(promptCategories.position), asc(promptCategories.name))
      .all();
    const categoryPositions = new Map(
      orderedCategoryRows.map((category) => [category.id, category.position]),
    );
    const orderedCategoryIds = [
      ...defaultPromptCategories.map(
        (seed) => categoryIdsByDefaultKey.get(seed.defaultKey)!,
      ),
      ...orderedCategoryRows
        .filter((category) => category.defaultKey === null)
        .map((category) => category.id),
    ];
    orderedCategoryIds.forEach((id, position) => {
      if (categoryPositions.get(id) === position) {
        return;
      }
      tx
        .update(promptCategories)
        .set({ position })
        .where(eq(promptCategories.id, id))
        .run();
    });

    const orderedPromptRows = tx
      .select()
      .from(prompts)
      .where(inLibrary.prompts)
      .orderBy(asc(prompts.position), asc(prompts.name))
      .all();
    const promptIdsByDefaultKey = new Map(
      orderedPromptRows
        .filter((prompt) => prompt.defaultKey !== null)
        .map((prompt) => [prompt.defaultKey!, prompt.id]),
    );
    const orderedPromptIds = [
      ...defaultPrompts.map(
        (seed) => promptIdsByDefaultKey.get(seed.defaultKey)!,
      ),
      ...orderedPromptRows
        .filter((prompt) => prompt.defaultKey === null)
        .map((prompt) => prompt.id),
    ];
    orderedPromptIds.forEach((id, position) => {
      if (
        orderedPromptRows.find((prompt) => prompt.id === id)?.position ===
        position
      ) {
        return;
      }
      tx.update(prompts).set({ position }).where(eq(prompts.id, id)).run();
    });
  }

  private findDefaultLibrary(executor: Executor) {
    return executor
      .select()
      .from(promptLibraries)
      .where(eq(promptLibraries.defaultKey, DEFAULT_PROMPT_LIBRARY_KEY))
      .get();
  }

  // The migration creates the row; this only covers a database where it went
  // missing. Position 0 keeps Default first in the pills row.
  private ensureDefaultLibraryRow(tx: Transaction) {
    return (
      this.findDefaultLibrary(tx) ??
      tx
        .insert(promptLibraries)
        .values({
          id: DEFAULT_PROMPT_LIBRARY_ID,
          name: DEFAULT_PROMPT_LIBRARY_NAME,
          position: 0,
          defaultKey: DEFAULT_PROMPT_LIBRARY_KEY,
        })
        .returning()
        .get()
    );
  }

  private countRows(
    executor: Executor,
    table: typeof prompts | typeof promptCategories,
    column: typeof prompts.libraryId | typeof promptCategories.libraryId,
    libraryId: string,
  ) {
    const row = executor
      .select({ count: sql<number>`count(*)` })
      .from(table)
      .where(eq(column, libraryId))
      .get();
    return row?.count ?? 0;
  }

  // Scoped to one library when asked, so a library-scoped listing (and the
  // restore-defaults response built from it) never reads other libraries'
  // links and stays proportional to the selected library.
  private linksByPromptId(libraryId?: string) {
    const links = this.db
      .select({
        promptId: promptCategoryLinks.promptId,
        categoryId: promptCategoryLinks.categoryId,
      })
      .from(promptCategoryLinks)
      .innerJoin(prompts, eq(prompts.id, promptCategoryLinks.promptId))
      .where(libraryId ? eq(prompts.libraryId, libraryId) : undefined)
      .orderBy(asc(promptCategoryLinks.position))
      .all();

    const byPromptId = new Map<string, string[]>();
    for (const link of links) {
      const categoryIds = byPromptId.get(link.promptId) ?? [];
      categoryIds.push(link.categoryId);
      byPromptId.set(link.promptId, categoryIds);
    }
    return byPromptId;
  }

  private categoryIdsForPrompt(promptId: string) {
    return this.db
      .select({ categoryId: promptCategoryLinks.categoryId })
      .from(promptCategoryLinks)
      .where(eq(promptCategoryLinks.promptId, promptId))
      .orderBy(asc(promptCategoryLinks.position))
      .all()
      .map((link) => link.categoryId);
  }

  // A prompt may only link to categories of its own library.
  private resolveCategoryIds(
    categoryIds: string[] | undefined,
    libraryId: string,
  ) {
    const unique = [...new Set(categoryIds ?? [])];
    for (const categoryId of unique) {
      const category = this.getCategory(categoryId);
      if (category.libraryId !== libraryId) {
        throw new ApiError(
          400,
          "invalid_request",
          "Prompt category belongs to a different library",
          { categoryId, libraryId: category.libraryId },
        );
      }
    }
    return unique;
  }

  private insertLinks(
    tx: Transaction,
    promptId: string,
    categoryIds: string[],
  ) {
    categoryIds.forEach((categoryId, index) => {
      tx
        .insert(promptCategoryLinks)
        .values({ promptId, categoryId, position: index })
        .run();
    });
  }

  private nextPromptPosition(libraryId: string, tx?: Transaction) {
    const row = (tx ?? this.db)
      .select({ max: sql<number | null>`MAX(${prompts.position})` })
      .from(prompts)
      .where(eq(prompts.libraryId, libraryId))
      .get();
    return (row?.max ?? -1) + 1;
  }

  private nextCategoryPosition(libraryId: string) {
    const row = this.db
      .select({ max: sql<number | null>`MAX(${promptCategories.position})` })
      .from(promptCategories)
      .where(eq(promptCategories.libraryId, libraryId))
      .get();
    return (row?.max ?? -1) + 1;
  }

  private nextLibraryPosition() {
    const row = this.db
      .select({ max: sql<number | null>`MAX(${promptLibraries.position})` })
      .from(promptLibraries)
      .get();
    return (row?.max ?? -1) + 1;
  }

  private ensureCategoryNameAvailable(
    libraryId: string,
    name: string,
    exceptCategoryId?: string,
  ) {
    const existing = this.db
      .select({ id: promptCategories.id })
      .from(promptCategories)
      .where(
        and(
          eq(promptCategories.libraryId, libraryId),
          eq(promptCategories.name, name),
          exceptCategoryId
            ? ne(promptCategories.id, exceptCategoryId)
            : undefined,
        ),
      )
      .get();

    if (existing) {
      throw new ApiError(409, "invalid_state", "Prompt category name already exists");
    }
  }

  // Names are trimmed and must not be empty. "Default" in any casing is
  // reserved for the system library so the pills row never shows two of them.
  private validateLibraryName(name: string) {
    const trimmed = name.trim();
    if (trimmed.length === 0) {
      throw new ApiError(
        400,
        "invalid_request",
        "Prompt library name is required",
      );
    }
    if (trimmed.toLowerCase() === DEFAULT_PROMPT_LIBRARY_NAME.toLowerCase()) {
      throw new ApiError(
        400,
        "invalid_request",
        `"${DEFAULT_PROMPT_LIBRARY_NAME}" is reserved for the system prompt library`,
      );
    }
    return trimmed;
  }

  private ensureLibraryNameAvailable(name: string, exceptLibraryId?: string) {
    const existing = this.db
      .select({ id: promptLibraries.id })
      .from(promptLibraries)
      .where(
        and(
          eq(promptLibraries.name, name),
          exceptLibraryId ? ne(promptLibraries.id, exceptLibraryId) : undefined,
        ),
      )
      .get();

    if (existing) {
      throw new ApiError(409, "invalid_state", "Prompt library name already exists");
    }
  }
}

export function isDefaultLibrary(library: PromptLibrary) {
  return library.defaultKey === DEFAULT_PROMPT_LIBRARY_KEY;
}

// `position` is resolved against the list with the moved row already taken
// out, so dropping onto a row takes that row's slot whether the drag went up
// or down. Writing the whole list back as 0..n-1 also heals the gaps that
// deletes and restore-defaults leave behind.
function orderWithMovedId(ids: string[], movedId: string, position: number) {
  const rest = ids.filter((id) => id !== movedId);
  rest.splice(Math.max(0, Math.min(position, rest.length)), 0, movedId);
  return rest;
}
