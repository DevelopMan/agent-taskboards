import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDatabaseClient, type DatabaseClient } from "../db/client.js";
import { runMigrations } from "../db/migrate.js";
import {
  promptCategories,
  promptCategoryLinks,
  promptLibraries,
  prompts,
  type PromptLibrary,
} from "../db/schema.js";
import { ApiError } from "../http/errors.js";
import {
  defaultPromptCategories,
  defaultPrompts,
} from "../models/default-prompts.js";
import type { PromptLibraryImportInput } from "../models/request-schemas.js";
import {
  PROMPT_LIBRARY_EXPORT_FORMAT,
  PROMPT_LIBRARY_EXPORT_VERSION,
} from "./prompt-library-import.js";
import {
  DEFAULT_PROMPT_LIBRARY_ID,
  DEFAULT_PROMPT_LIBRARY_KEY,
  PromptService,
} from "./prompt-service.js";

// 0007_prompt_libraries.sql leaves two libraries behind: an empty Default and
// a Custom library holding the 0006 seed rows with their default keys cleared.
// ensureDefaultLibrary() fills Default from default-prompts.ts, which is what
// createApp() does on startup. Custom therefore doubles as the "other library"
// that scoping and restore must leave alone.
const CUSTOM_LIBRARY_ID = "prompt-library-custom";

describe("PromptService", () => {
  let tmpDir: string;
  let client: DatabaseClient;
  let service: PromptService;
  let defaultLibrary: PromptLibrary;
  let customLibrary: PromptLibrary;
  let firstEnsure: ReturnType<PromptService["ensureDefaultLibrary"]>;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "taskboards-prompts-"));
    const databasePath = join(tmpDir, "test.sqlite");
    runMigrations({
      databasePath,
      migrationsDir: resolve(process.cwd(), "drizzle"),
    });
    client = createDatabaseClient(databasePath);
    service = new PromptService(client);
    firstEnsure = service.ensureDefaultLibrary();
    defaultLibrary = firstEnsure.library;
    customLibrary = service.getLibrary(CUSTOM_LIBRARY_ID);
  });

  afterEach(() => {
    client.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  const promptIds = (libraryId = defaultLibrary.id) =>
    service.listPrompts({ libraryId }).map(({ prompt }) => prompt.id);

  const categoryIds = (libraryId = defaultLibrary.id) =>
    service.listCategories({ libraryId }).map((category) => category.id);

  const expectContiguousPromptPositions = (libraryId = defaultLibrary.id) => {
    const positions = service
      .listPrompts({ libraryId })
      .map(({ prompt }) => prompt.position);
    expect(positions).toEqual(positions.map((_, index) => index));
  };

  const expectApiError = (
    action: () => unknown,
    status: number,
    code: string,
  ) => {
    let caught: unknown;
    try {
      action();
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ApiError);
    const apiError = caught as ApiError;
    expect(apiError.status).toBe(status);
    expect(apiError.code).toBe(code);
  };

  // Everything in a library, in a shape that survives a deep-equal after
  // another library was changed.
  const snapshotLibrary = (libraryId: string) => ({
    categories: service.listCategories({ libraryId }),
    prompts: service.listPrompts({ libraryId }),
  });

  const inDefault = <T extends object>(input: T) => ({
    libraryId: defaultLibrary.id,
    ...input,
  });

  describe("Default library seeding", () => {
    it("seeds the Default library on first ensure and is idempotent", () => {
      expect(firstEnsure.seeded).toBe(true);
      expect(defaultLibrary).toMatchObject({
        id: DEFAULT_PROMPT_LIBRARY_ID,
        name: "Default",
        position: 0,
        defaultKey: DEFAULT_PROMPT_LIBRARY_KEY,
      });

      const categories = service.listCategories({ libraryId: defaultLibrary.id });
      expect(categories.map((category) => category.defaultKey)).toEqual(
        defaultPromptCategories.map((seed) => seed.defaultKey),
      );
      for (const seed of defaultPromptCategories) {
        const category = categories.find(
          (item) => item.defaultKey === seed.defaultKey,
        );
        expect(category).toMatchObject({
          libraryId: defaultLibrary.id,
          name: seed.name,
          description: seed.description,
          position: seed.position,
        });
      }

      const seeded = service.listPrompts({ libraryId: defaultLibrary.id });
      expect(seeded.map(({ prompt }) => prompt.defaultKey)).toEqual(
        defaultPrompts.map((seed) => seed.defaultKey),
      );
      for (const seed of defaultPrompts) {
        const match = seeded.find(
          ({ prompt }) => prompt.defaultKey === seed.defaultKey,
        );
        expect(match?.prompt).toMatchObject({
          libraryId: defaultLibrary.id,
          name: seed.name,
          body: seed.body,
          note: seed.note,
          position: seed.position,
          usageCount: 0,
        });
        expect(match?.categoryIds).toEqual(
          seed.categoryDefaultKeys.map(
            (key) => categories.find((category) => category.defaultKey === key)!.id,
          ),
        );
      }

      const before = snapshotLibrary(defaultLibrary.id);
      const again = service.ensureDefaultLibrary();
      expect(again.seeded).toBe(false);
      expect(again.library).toEqual(defaultLibrary);
      expect(snapshotLibrary(defaultLibrary.id)).toEqual(before);
    });

    it("leaves a non-empty Default library alone and reseeds an emptied one", () => {
      const [firstPromptId] = promptIds();
      service.deletePrompt(firstPromptId);

      expect(service.ensureDefaultLibrary().seeded).toBe(false);
      expect(promptIds()).not.toContain(firstPromptId);
      expect(promptIds()).toHaveLength(defaultPrompts.length - 1);

      for (const id of promptIds()) {
        service.deletePrompt(id);
      }
      for (const id of categoryIds()) {
        service.deleteCategory(id);
      }
      expect(service.ensureDefaultLibrary().seeded).toBe(true);
      expect(promptIds()).toHaveLength(defaultPrompts.length);
      expect(categoryIds()).toHaveLength(defaultPromptCategories.length);
    });

    it("never touches the Custom library while seeding", () => {
      const custom = snapshotLibrary(customLibrary.id);
      expect(custom.prompts.length).toBeGreaterThan(0);
      expect(custom.prompts.every(({ prompt }) => prompt.defaultKey === null)).toBe(
        true,
      );
      expect(custom.categories.every((category) => category.defaultKey === null)).toBe(
        true,
      );

      service.ensureDefaultLibrary();

      expect(snapshotLibrary(customLibrary.id)).toEqual(custom);
    });

    it("recreates a missing Default library row before seeding", () => {
      client.db
        .delete(promptLibraries)
        .where(eq(promptLibraries.id, defaultLibrary.id))
        .run();
      expectApiError(() => service.getDefaultLibrary(), 500, "internal_error");

      const ensured = service.ensureDefaultLibrary();

      expect(ensured.seeded).toBe(true);
      expect(ensured.library).toMatchObject({
        id: DEFAULT_PROMPT_LIBRARY_ID,
        name: "Default",
        defaultKey: DEFAULT_PROMPT_LIBRARY_KEY,
      });
      expect(service.getDefaultLibrary().id).toBe(DEFAULT_PROMPT_LIBRARY_ID);
      expect(promptIds()).toHaveLength(defaultPrompts.length);
    });
  });

  describe("libraries", () => {
    it("lists libraries by position then name and appends new ones", () => {
      expect(service.listLibraries().map((library) => library.name)).toEqual([
        "Default",
        "Custom",
      ]);

      const work = service.createLibrary({ name: "Work" });
      const experiments = service.createLibrary({ name: "  🧪 Experiments  " });

      expect(work).toMatchObject({ name: "Work", position: 2, defaultKey: null });
      expect(experiments).toMatchObject({ name: "🧪 Experiments", position: 3 });
      expect(service.listLibraries().map((library) => library.id)).toEqual([
        defaultLibrary.id,
        customLibrary.id,
        work.id,
        experiments.id,
      ]);

      client.db
        .update(promptLibraries)
        .set({ position: work.position })
        .where(eq(promptLibraries.id, experiments.id))
        .run();
      expect(service.listLibraries().map((library) => library.name)).toEqual([
        "Default",
        "Custom",
        "Work",
        "🧪 Experiments",
      ]);
    });

    it("enforces unique, non-empty names and reserves Default", () => {
      expectApiError(
        () => service.createLibrary({ name: "Custom" }),
        409,
        "invalid_state",
      );
      for (const reserved of ["Default", "default", "  DEFAULT "]) {
        expectApiError(
          () => service.createLibrary({ name: reserved }),
          400,
          "invalid_request",
        );
      }
      expectApiError(
        () => service.createLibrary({ name: "   " }),
        400,
        "invalid_request",
      );

      const mine = service.createLibrary({ name: "Mine" });
      expect(service.renameLibrary(customLibrary.id, "  Custom  ").name).toBe(
        "Custom",
      );
      expectApiError(
        () => service.renameLibrary(customLibrary.id, "Mine"),
        409,
        "invalid_state",
      );
      expectApiError(
        () => service.renameLibrary(customLibrary.id, "default"),
        400,
        "invalid_request",
      );
      expect(service.renameLibrary(mine.id, "Ours").name).toBe("Ours");
      expect(service.getLibrary(mine.id).name).toBe("Ours");
    });

    it("refuses to rename or delete the Default library", () => {
      expectApiError(
        () => service.renameLibrary(defaultLibrary.id, "Mine"),
        400,
        "invalid_request",
      );
      expectApiError(
        () => service.deleteLibrary(defaultLibrary.id),
        400,
        "invalid_request",
      );
      expect(service.getDefaultLibrary()).toEqual(defaultLibrary);
    });

    it("returns 404 for unknown library ids everywhere they are accepted", () => {
      expectApiError(() => service.getLibrary("missing"), 404, "not_found");
      expectApiError(
        () => service.renameLibrary("missing", "X"),
        404,
        "not_found",
      );
      expectApiError(() => service.deleteLibrary("missing"), 404, "not_found");
      expectApiError(
        () => service.createCategory({ libraryId: "missing", name: "X" }),
        404,
        "not_found",
      );
      expectApiError(
        () => service.createPrompt({ libraryId: "missing", name: "X", body: "x" }),
        404,
        "not_found",
      );
      expectApiError(
        () => service.listPrompts({ libraryId: "missing" }),
        404,
        "not_found",
      );
      expectApiError(
        () => service.listCategories({ libraryId: "missing" }),
        404,
        "not_found",
      );
    });

    it("deletes a library with its categories, prompts, and links and reports counts", () => {
      const temp = service.createLibrary({ name: "Temp" });
      const categoryA = service.createCategory({ libraryId: temp.id, name: "A" });
      const categoryB = service.createCategory({ libraryId: temp.id, name: "B" });
      const linked = service.createPrompt({
        libraryId: temp.id,
        name: "Linked",
        body: "body",
        categoryIds: [categoryA.id, categoryB.id],
      });
      service.createPrompt({ libraryId: temp.id, name: "Root", body: "body" });
      service.createPrompt({ libraryId: temp.id, name: "Other", body: "body" });
      const defaultBefore = snapshotLibrary(defaultLibrary.id);

      const result = service.deleteLibrary(temp.id);

      expect(result.library).toEqual(temp);
      expect(result.deleted).toEqual({ prompts: 3, categories: 2 });
      expectApiError(() => service.getLibrary(temp.id), 404, "not_found");
      expectApiError(() => service.getPrompt(linked.prompt.id), 404, "not_found");
      expectApiError(() => service.getCategory(categoryA.id), 404, "not_found");
      expect(
        client.db
          .select()
          .from(promptCategoryLinks)
          .where(eq(promptCategoryLinks.promptId, linked.prompt.id))
          .all(),
      ).toEqual([]);
      expect(snapshotLibrary(defaultLibrary.id)).toEqual(defaultBefore);
    });
  });

  describe("library scoping", () => {
    it("scopes category names, positions, and prompt positions per library", () => {
      const inDefaultLibrary = service.createCategory(
        inDefault({ name: "Review" }),
      );
      const inCustomLibrary = service.createCategory({
        libraryId: customLibrary.id,
        name: "Review",
      });
      expect(inDefaultLibrary.position).toBe(defaultPromptCategories.length);
      expect(inCustomLibrary.position).toBe(
        service.listCategories({ libraryId: customLibrary.id }).length - 1,
      );
      expectApiError(
        () => service.createCategory(inDefault({ name: "Review" })),
        409,
        "invalid_state",
      );
      // Renaming onto a name that only exists in another library is fine.
      service.createCategory(inDefault({ name: "Only in Default" }));
      expect(
        service.updateCategory(inCustomLibrary.id, { name: "Only in Default" })
          .name,
      ).toBe("Only in Default");
      expectApiError(
        () =>
          service.updateCategory(inDefaultLibrary.id, {
            name: "Only in Default",
          }),
        409,
        "invalid_state",
      );

      const customPromptCount = promptIds(customLibrary.id).length;
      const defaultPrompt = service.createPrompt(
        inDefault({ name: "New", body: "body" }),
      ).prompt;
      const customPrompt = service.createPrompt({
        libraryId: customLibrary.id,
        name: "New",
        body: "body",
      }).prompt;
      expect(defaultPrompt.position).toBe(defaultPrompts.length);
      expect(customPrompt.position).toBe(customPromptCount);
      expect(defaultPrompt.libraryId).toBe(defaultLibrary.id);
      expect(customPrompt.libraryId).toBe(customLibrary.id);
    });

    it("filters lists by library and returns every library when unfiltered", () => {
      const customCount = promptIds(customLibrary.id).length;
      expect(customCount).toBeGreaterThan(0);
      expect(promptIds()).toHaveLength(defaultPrompts.length);
      expect(service.listPrompts()).toHaveLength(
        defaultPrompts.length + customCount,
      );
      expect(
        service
          .listPrompts({ libraryId: customLibrary.id })
          .every(({ prompt }) => prompt.libraryId === customLibrary.id),
      ).toBe(true);
      expect(service.listCategories()).toHaveLength(
        categoryIds().length + categoryIds(customLibrary.id).length,
      );

      // A category filter from another library yields nothing rather than
      // leaking rows across the boundary.
      const [customCategoryId] = categoryIds(customLibrary.id);
      expect(
        service.listPrompts({
          libraryId: defaultLibrary.id,
          categoryId: customCategoryId,
        }),
      ).toEqual([]);
    });

    it("reorders prompts and categories within their own library only", () => {
      const defaultOrder = promptIds();
      const customOrder = promptIds(customLibrary.id);
      const defaultCategoryOrder = categoryIds();

      service.reorderPrompt(customOrder[customOrder.length - 1], 0);
      expect(promptIds(customLibrary.id)).toEqual([
        customOrder[customOrder.length - 1],
        ...customOrder.slice(0, -1),
      ]);
      expectContiguousPromptPositions(customLibrary.id);
      expect(promptIds()).toEqual(defaultOrder);

      const customCategories = categoryIds(customLibrary.id);
      service.reorderCategory(customCategories[customCategories.length - 1], 0);
      expect(categoryIds(customLibrary.id)).toEqual([
        customCategories[customCategories.length - 1],
        ...customCategories.slice(0, -1),
      ]);
      expect(categoryIds()).toEqual(defaultCategoryOrder);
    });

    it("rejects links to categories of another library", () => {
      const customCategory = service.createCategory({
        libraryId: customLibrary.id,
        name: "Elsewhere",
      });

      expectApiError(
        () =>
          service.createPrompt(
            inDefault({
              name: "Cross",
              body: "body",
              categoryIds: [customCategory.id],
            }),
          ),
        400,
        "invalid_request",
      );

      const prompt = service.createPrompt(
        inDefault({ name: "Stays", body: "body" }),
      );
      expectApiError(
        () =>
          service.updatePrompt(prompt.prompt.id, {
            categoryIds: [customCategory.id],
          }),
        400,
        "invalid_request",
      );
      expect(service.getPrompt(prompt.prompt.id).categoryIds).toEqual([]);
      expect(service.getPrompt(prompt.prompt.id).prompt.libraryId).toBe(
        defaultLibrary.id,
      );
    });
  });

  it("creates, updates, and rejects duplicate categories", () => {
    const category = service.createCategory(inDefault({ name: "🚀 Release" }));
    expect(category.position).toBeGreaterThan(0);
    expect(category.libraryId).toBe(defaultLibrary.id);

    expect(() =>
      service.createCategory(inDefault({ name: "🚀 Release" })),
    ).toThrowError(ApiError);

    const updated = service.updateCategory(category.id, {
      description: "Release prompts",
    });
    expect(updated.description).toBe("Release prompts");
    expect(updated.libraryId).toBe(defaultLibrary.id);
    expect(() =>
      service.updateCategory(category.id, { name: "Planning" }),
    ).toThrowError(ApiError);
  });

  it("creates prompts with and without categories and lists by filters", () => {
    const category = service.createCategory(inDefault({ name: "Review" }));
    const inCategory = service.createPrompt(
      inDefault({
        name: "Review checklist",
        body: "Check {{TASK}} carefully.",
        categoryIds: [category.id],
      }),
    );
    const rootLevel = service.createPrompt(
      inDefault({ name: "Root prompt", body: "No category here." }),
    );

    expect(inCategory.categoryIds).toEqual([category.id]);
    expect(rootLevel.categoryIds).toEqual([]);

    const byCategory = service.listPrompts({ categoryId: category.id });
    expect(byCategory.map(({ prompt }) => prompt.id)).toEqual([
      inCategory.prompt.id,
    ]);

    const byQuery = service.listPrompts({ q: "no category" });
    expect(byQuery.map(({ prompt }) => prompt.id)).toEqual([
      rootLevel.prompt.id,
    ]);

    expect(() =>
      service.createPrompt(
        inDefault({
          name: "Broken",
          body: "x",
          categoryIds: ["missing-category"],
        }),
      ),
    ).toThrowError(ApiError);
  });

  it("stores, updates, and clears an author note", () => {
    const created = service.createPrompt(
      inDefault({
        name: "Noted",
        body: "body",
        note: "Use this before opening a PR.",
      }),
    );
    expect(created.prompt.note).toBe("Use this before opening a PR.");

    const withoutNote = service.createPrompt(
      inDefault({ name: "Plain", body: "body" }),
    );
    expect(withoutNote.prompt.note).toBeNull();

    const updated = service.updatePrompt(created.prompt.id, {
      note: "Updated guidance.",
    });
    expect(updated.prompt.note).toBe("Updated guidance.");
    expect(updated.prompt.name).toBe("Noted");

    const cleared = service.updatePrompt(created.prompt.id, { note: null });
    expect(cleared.prompt.note).toBeNull();
  });

  it("replaces the category link set only when categoryIds is supplied", () => {
    const categoryA = service.createCategory(inDefault({ name: "A" }));
    const categoryB = service.createCategory(inDefault({ name: "B" }));
    const created = service.createPrompt(
      inDefault({ name: "Multi", body: "body", categoryIds: [categoryA.id] }),
    );

    const renamed = service.updatePrompt(created.prompt.id, {
      name: "Multi renamed",
    });
    expect(renamed.prompt.name).toBe("Multi renamed");
    expect(renamed.categoryIds).toEqual([categoryA.id]);

    const relinked = service.updatePrompt(created.prompt.id, {
      categoryIds: [categoryB.id, categoryA.id],
    });
    expect(relinked.categoryIds).toEqual([categoryB.id, categoryA.id]);

    const cleared = service.updatePrompt(created.prompt.id, {
      categoryIds: [],
    });
    expect(cleared.categoryIds).toEqual([]);
  });

  it("keeps prompts when their category is deleted", () => {
    const category = service.createCategory(inDefault({ name: "Ephemeral" }));
    const created = service.createPrompt(
      inDefault({ name: "Survivor", body: "body", categoryIds: [category.id] }),
    );

    service.deleteCategory(category.id);

    const survivor = service.getPrompt(created.prompt.id);
    expect(survivor.categoryIds).toEqual([]);
    expect(
      client.db.select().from(promptCategoryLinks).all().filter(
        (link) => link.categoryId === category.id,
      ),
    ).toEqual([]);
  });

  it("hard-deletes prompts and cascades their links", () => {
    const category = service.createCategory(inDefault({ name: "Holder" }));
    const created = service.createPrompt(
      inDefault({ name: "Doomed", body: "body", categoryIds: [category.id] }),
    );

    service.deletePrompt(created.prompt.id);

    expect(() => service.getPrompt(created.prompt.id)).toThrowError(ApiError);
    expect(
      client.db
        .select()
        .from(promptCategoryLinks)
        .all()
        .filter((link) => link.promptId === created.prompt.id),
    ).toEqual([]);
  });

  it("records prompt usage", () => {
    const created = service.createPrompt(inDefault({ name: "Used", body: "body" }));
    expect(created.prompt.usageCount).toBe(0);
    expect(created.prompt.lastUsedAt).toBeNull();

    const once = service.recordPromptUse(created.prompt.id);
    const twice = service.recordPromptUse(created.prompt.id);

    expect(once.prompt.usageCount).toBe(1);
    expect(twice.prompt.usageCount).toBe(2);
    expect(twice.prompt.lastUsedAt).toBeInstanceOf(Date);
  });

  it("reorders a prompt within its library's single order", () => {
    const first = service.createPrompt(inDefault({ name: "First", body: "body" }))
      .prompt;
    const second = service.createPrompt(
      inDefault({ name: "Second", body: "body" }),
    ).prompt;
    const seeded = promptIds().filter(
      (id) => id !== first.id && id !== second.id,
    );

    service.reorderPrompt(second.id, 0);
    expect(promptIds()).toEqual([second.id, ...seeded, first.id]);
    expectContiguousPromptPositions();

    // Past the end clamps instead of leaving a hole.
    service.reorderPrompt(second.id, 99);
    expect(promptIds()).toEqual([...seeded, first.id, second.id]);
    expectContiguousPromptPositions();
  });

  it("gives the moved prompt the target's slot when dragging downwards", () => {
    const ids = promptIds();
    const [top, , third] = ids;

    // `position` counts the list without the moved row, so dropping the top
    // prompt onto the third one lands on the third slot, not the second.
    service.reorderPrompt(top, ids.indexOf(third));

    expect(promptIds()).toEqual([ids[1], third, top, ...ids.slice(3)]);
  });

  it("renormalizes gapped positions on the first reorder", () => {
    const ids = promptIds();
    for (const [index, id] of ids.entries()) {
      client.db
        .update(prompts)
        .set({ position: index * 3 })
        .where(eq(prompts.id, id))
        .run();
    }

    service.reorderPrompt(ids[2], 0);

    expect(promptIds()).toEqual([ids[2], ids[0], ids[1], ...ids.slice(3)]);
    expectContiguousPromptPositions();
  });

  it("leaves usage counters untouched when reordering", () => {
    const created = service.createPrompt(
      inDefault({ name: "Unused", body: "body" }),
    ).prompt;
    service.recordPromptUse(created.id);
    const before = service.getPrompt(created.id).prompt;

    const after = service.reorderPrompt(created.id, 0).prompt;

    expect(after.usageCount).toBe(before.usageCount);
    expect(after.lastUsedAt).toEqual(before.lastUsedAt);
  });

  it("reorders categories independently of prompts", () => {
    const category = service.createCategory(inDefault({ name: "🚀 Release" }));
    const seeded = categoryIds().filter((id) => id !== category.id);
    const promptOrderBefore = promptIds();

    service.reorderCategory(category.id, 0);

    expect(categoryIds()).toEqual([category.id, ...seeded]);
    expect(
      service
        .listCategories({ libraryId: defaultLibrary.id })
        .map((item) => item.position),
    ).toEqual([0, ...seeded.map((_, index) => index + 1)]);
    expect(promptIds()).toEqual(promptOrderBefore);
  });

  it("rejects reordering an unknown prompt or category", () => {
    expect(() => service.reorderPrompt("missing-prompt", 0)).toThrowError(
      ApiError,
    );
    expect(() => service.reorderCategory("missing-category", 0)).toThrowError(
      ApiError,
    );
  });

  describe("restoreDefaults", () => {
    it("restores deleted defaults idempotently and reports the Default library", () => {
      const noop = service.restoreDefaults();
      expect(noop.restored).toEqual([]);
      expect(noop.library).toEqual(defaultLibrary);
      expect(noop.prompts.every(({ prompt }) => prompt.libraryId === defaultLibrary.id)).toBe(
        true,
      );
      expect(
        noop.categories.every((category) => category.libraryId === defaultLibrary.id),
      ).toBe(true);
      expect(noop.prompts).toHaveLength(defaultPrompts.length);

      const target = service
        .listPrompts({ libraryId: defaultLibrary.id })
        .find(({ prompt }) => prompt.defaultKey === "umbrella-implement")!;
      service.deletePrompt(target.prompt.id);

      const restored = service.restoreDefaults();
      expect(restored.restored).toEqual(["prompt:umbrella-implement"]);

      const after = service
        .listPrompts({ libraryId: defaultLibrary.id })
        .find(({ prompt }) => prompt.defaultKey === "umbrella-implement");
      const seedBody = defaultPrompts.find(
        (seed) => seed.defaultKey === "umbrella-implement",
      )!.body;
      expect(after?.prompt.body).toBe(seedBody);
      expect(after?.categoryIds).toHaveLength(1);

      expect(service.restoreDefaults().restored).toEqual([]);
    });

    it("reconciles edited defaults while preserving custom rows in Default", () => {
      const customCategory = service.createCategory(
        inDefault({ name: "Custom category" }),
      );
      const customPrompt = service.createPrompt(
        inDefault({
          name: "Custom prompt",
          body: "Keep me",
          note: "Keep this note",
          categoryIds: [customCategory.id],
        }),
      );
      const targetSeed = defaultPrompts.find(
        (seed) => seed.defaultKey === "umbrella-implement",
      )!;
      const target = service
        .listPrompts({ libraryId: defaultLibrary.id })
        .find(({ prompt }) => prompt.defaultKey === targetSeed.defaultKey)!;
      const used = service.recordPromptUse(target.prompt.id).prompt;
      service.updatePrompt(target.prompt.id, {
        name: "Edited default",
        body: "Edited body",
        note: "Edited note",
        categoryIds: [customCategory.id],
      });
      service.reorderPrompt(target.prompt.id, defaultPrompts.length - 1);

      const restored = service.restoreDefaults();

      expect(restored.restored).toEqual(
        defaultPrompts.slice(1).map((seed) => `prompt:${seed.defaultKey}`),
      );
      const reconciled = service.getPrompt(target.prompt.id);
      expect(reconciled.prompt.name).toBe(targetSeed.name);
      expect(reconciled.prompt.body).toBe(targetSeed.body);
      expect(reconciled.prompt.note).toBe(targetSeed.note);
      expect(reconciled.prompt.position).toBe(targetSeed.position);
      expect(reconciled.prompt.usageCount).toBe(1);
      expect(reconciled.prompt.lastUsedAt).toEqual(used.lastUsedAt);
      expect(
        reconciled.categoryIds.map(
          (categoryId) => service.getCategory(categoryId).defaultKey,
        ),
      ).toEqual(targetSeed.categoryDefaultKeys);
      expect(service.getPrompt(customPrompt.prompt.id).prompt).toMatchObject({
        name: "Custom prompt",
        body: "Keep me",
        note: "Keep this note",
        position: defaultPrompts.length,
        defaultKey: null,
        libraryId: defaultLibrary.id,
      });
      expect(service.getPrompt(customPrompt.prompt.id).categoryIds).toEqual([
        customCategory.id,
      ]);
      expect(service.restoreDefaults().restored).toEqual([]);
    });

    it("recreates deleted default categories and exact prompt links", () => {
      const implementing = service
        .listCategories({ libraryId: defaultLibrary.id })
        .find((category) => category.defaultKey === "implementing")!;
      service.deleteCategory(implementing.id);

      const restored = service.restoreDefaults();
      expect(restored.restored[0]).toBe("category:implementing");

      const recreated = service
        .listCategories({ libraryId: defaultLibrary.id })
        .find((category) => category.defaultKey === "implementing")!;
      expect(recreated.id).not.toBe(implementing.id);
      expect(recreated.libraryId).toBe(defaultLibrary.id);
      for (const seed of defaultPrompts) {
        const prompt = service
          .listPrompts({ libraryId: defaultLibrary.id })
          .find((item) => item.prompt.defaultKey === seed.defaultKey)!;
        expect(
          prompt.categoryIds.map(
            (categoryId) => service.getCategory(categoryId).defaultKey,
          ),
        ).toEqual(seed.categoryDefaultKeys);
      }

      expect(service.restoreDefaults().restored).toEqual([]);
    });

    it("adopts same-named rows created before their default keys existed", () => {
      const planning = service
        .listCategories({ libraryId: defaultLibrary.id })
        .find((category) => category.defaultKey === "planning")!;
      const seed = defaultPrompts.find(
        (candidate) => candidate.defaultKey === "expand-task",
      )!;
      const seededPrompt = service
        .listPrompts({ libraryId: defaultLibrary.id })
        .find(({ prompt }) => prompt.defaultKey === seed.defaultKey)!;
      service.deletePrompt(seededPrompt.prompt.id);
      service.deleteCategory(planning.id);
      const category = service.createCategory(inDefault({ name: "Planning" }));
      const prompt = service.createPrompt(
        inDefault({
          name: seed.name,
          body: seed.body,
          note: seed.note,
          categoryIds: [category.id],
        }),
      );

      const restored = service.restoreDefaults();
      expect(restored.restored).toEqual([
        "category:planning",
        "prompt:expand-task",
        "prompt:create-scoped-tasks",
      ]);
      expect(service.getCategory(category.id).defaultKey).toBe("planning");
      expect(service.getPrompt(prompt.prompt.id).prompt.defaultKey).toBe(
        "expand-task",
      );
      expect(
        service
          .listPrompts({ libraryId: defaultLibrary.id })
          .filter(({ prompt: item }) => item.name === seed.name),
      ).toHaveLength(1);
    });

    it("removes obsolete system defaults but preserves custom rows", () => {
      const custom = service.createPrompt(inDefault({ name: "Mine", body: "body" }));
      client.db
        .insert(prompts)
        .values({
          libraryId: defaultLibrary.id,
          name: "Obsolete default",
          body: "old",
          position: 99,
          defaultKey: "obsolete-default",
        })
        .run();
      client.db
        .insert(promptCategories)
        .values({
          libraryId: defaultLibrary.id,
          name: "Obsolete category",
          position: 99,
          defaultKey: "obsolete-category",
        })
        .run();

      const restored = service.restoreDefaults();

      expect(restored.restored).toEqual([
        "removed:prompt:obsolete-default",
        "removed:category:obsolete-category",
      ]);
      expect(
        service.listPrompts().some(
          ({ prompt }) => prompt.defaultKey === "obsolete-default",
        ),
      ).toBe(false);
      expect(
        service
          .listCategories()
          .some((category) => category.defaultKey === "obsolete-category"),
      ).toBe(false);
      expect(service.getPrompt(custom.prompt.id).prompt.position).toBe(
        defaultPrompts.length,
      );
    });

    it("never reads or writes other libraries", () => {
      // Custom holds unkeyed copies of the seed under their canonical names,
      // which is exactly what adoption would pick up if it were not scoped.
      const customPlanning = service
        .listCategories({ libraryId: customLibrary.id })
        .find((category) => category.name === "Planning")!;
      const customSeedCopy = service
        .listPrompts({ libraryId: customLibrary.id })
        .find(({ prompt }) => prompt.name === defaultPrompts[0].name)!;
      service.updatePrompt(customSeedCopy.prompt.id, { body: "Edited in Custom" });
      service.createPrompt({
        libraryId: customLibrary.id,
        name: "Custom only",
        body: "body",
        categoryIds: [customPlanning.id],
      });
      const customBefore = snapshotLibrary(customLibrary.id);

      const defaultPlanning = service
        .listCategories({ libraryId: defaultLibrary.id })
        .find((category) => category.defaultKey === "planning")!;
      service.deleteCategory(defaultPlanning.id);
      const [defaultFirst] = promptIds();
      service.deletePrompt(defaultFirst);

      const restored = service.restoreDefaults();

      expect(restored.restored).toContain("category:planning");
      expect(restored.restored).toContain(`prompt:${defaultPrompts[0].defaultKey}`);
      expect(restored.library.id).toBe(defaultLibrary.id);
      expect(restored.prompts.every(({ prompt }) => prompt.libraryId === defaultLibrary.id)).toBe(
        true,
      );
      expect(snapshotLibrary(customLibrary.id)).toEqual(customBefore);
      expect(service.getCategory(customPlanning.id).defaultKey).toBeNull();
      expect(service.getPrompt(customSeedCopy.prompt.id).prompt).toMatchObject({
        defaultKey: null,
        body: "Edited in Custom",
      });
      expect(service.restoreDefaults().restored).toEqual([]);
    });

    it("recreates a missing Default library row", () => {
      client.db
        .delete(promptLibraries)
        .where(eq(promptLibraries.id, defaultLibrary.id))
        .run();

      const restored = service.restoreDefaults();

      expect(restored.library.defaultKey).toBe(DEFAULT_PROMPT_LIBRARY_KEY);
      expect(restored.prompts).toHaveLength(defaultPrompts.length);
      expect(restored.restored).toHaveLength(
        defaultPrompts.length + defaultPromptCategories.length,
      );
    });
  });

  describe("export and import", () => {
    // A parsed import document, shaped like promptLibraryImportSchema's
    // output so the service sees exactly what the route hands it.
    const document = (
      overrides: Partial<PromptLibraryImportInput> = {},
    ): PromptLibraryImportInput => ({
      format: PROMPT_LIBRARY_EXPORT_FORMAT,
      version: PROMPT_LIBRARY_EXPORT_VERSION,
      exportedAt: "2026-09-28T12:00:00.000Z",
      library: { name: "Team", metadata: { owner: "denis" } },
      categories: [
        { name: "Planning", description: "Before code", metadata: {} },
        { name: "Ops", description: null, metadata: { color: "red" } },
      ],
      prompts: [
        {
          name: "Plan",
          body: "Plan {{TASK}}",
          note: "Use first",
          metadata: {},
          categories: ["Ops", "Planning"],
        },
        { name: "Deploy", body: "Deploy it", note: null, metadata: { k: 1 }, categories: ["Ops"] },
        { name: "Loose", body: "No category", note: null, metadata: {}, categories: [] },
      ],
      ...overrides,
    });

    const libraryNames = () => service.listLibraries().map((library) => library.name);

    it("exports content and metadata in position and link order without ids or counters", () => {
      const library = service.createLibrary({ name: "Team" });
      const ops = service.createCategory({ libraryId: library.id, name: "Ops" });
      const planning = service.createCategory({
        libraryId: library.id,
        name: "Planning",
        description: "Before code",
      });
      service.reorderCategory(planning.id, 0);
      const plan = service.createPrompt({
        libraryId: library.id,
        name: "Plan",
        body: "Plan {{TASK}}",
        note: "Use first",
        categoryIds: [ops.id, planning.id],
        metadata: { k: 1 },
      });
      service.createPrompt({ libraryId: library.id, name: "Loose", body: "No category" });
      service.recordPromptUse(plan.prompt.id);

      const exported = service.exportLibrary(library.id);

      expect(exported.format).toBe("taskboards-prompt-library");
      expect(exported.version).toBe(1);
      expect(Date.parse(exported.exportedAt)).not.toBeNaN();
      expect(exported.library).toEqual({ name: "Team", metadata: {} });
      expect(exported.categories).toEqual([
        { name: "Planning", description: "Before code", metadata: {} },
        { name: "Ops", description: null, metadata: {} },
      ]);
      expect(exported.prompts).toEqual([
        {
          name: "Plan",
          body: "Plan {{TASK}}",
          note: "Use first",
          metadata: { k: 1 },
          categories: ["Ops", "Planning"],
        },
        { name: "Loose", body: "No category", note: null, metadata: {}, categories: [] },
      ]);
    });

    it("exports Default without default keys or usage", () => {
      const exported = service.exportLibrary(defaultLibrary.id);
      expect(exported.library.name).toBe("Default");
      expect(exported.prompts).toHaveLength(defaultPrompts.length);
      expect(exported.categories.map((category) => category.name)).toEqual(
        defaultPromptCategories.map((seed) => seed.name),
      );
      for (const prompt of exported.prompts) {
        expect(Object.keys(prompt).sort()).toEqual(
          ["body", "categories", "metadata", "name", "note"],
        );
      }
    });

    it("rejects exporting an unknown library", () => {
      expectApiError(() => service.exportLibrary("nope"), 404, "not_found");
    });

    it("imports a new library at the end and round-trips through export", () => {
      const result = service.importLibrary(document());

      expect(result.mode).toBe("create");
      expect(result.created).toEqual({ categories: 2, prompts: 3 });
      expect(result.updated).toEqual({ categories: 0, prompts: 0 });
      expect(result.skipped).toEqual({ prompts: 0 });
      expect(result.library).toMatchObject({
        name: "Team",
        defaultKey: null,
        metadata: { owner: "denis" },
        position: 2,
      });
      expect(libraryNames()).toEqual(["Default", "Custom", "Team"]);

      const roundTrip = service.exportLibrary(result.library.id);
      const source = document();
      expect(roundTrip).toEqual({
        ...source,
        onConflict: undefined,
        exportedAt: roundTrip.exportedAt,
      });

      const rows = service.listPrompts({ libraryId: result.library.id });
      expect(rows.map(({ prompt }) => prompt.position)).toEqual([0, 1, 2]);
      for (const { prompt } of rows) {
        expect(prompt.usageCount).toBe(0);
        expect(prompt.lastUsedAt).toBeNull();
        expect(prompt.defaultKey).toBeNull();
      }
      expect(
        service.listCategories({ libraryId: result.library.id }).map((category) => category.position),
      ).toEqual([0, 1]);
    });

    it("reports a taken name as a conflict and writes nothing without onConflict", () => {
      service.importLibrary(document());
      const before = snapshotLibrary(service.listLibraries()[2]!.id);

      let caught: unknown;
      try {
        service.importLibrary(document({ prompts: [] }));
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(ApiError);
      const apiError = caught as ApiError;
      expect(apiError.status).toBe(409);
      expect(apiError.details).toEqual({
        conflict: "library_exists",
        libraryId: service.listLibraries()[2]!.id,
        name: "Team",
      });
      expect(libraryNames()).toEqual(["Default", "Custom", "Team"]);
      expect(snapshotLibrary(service.listLibraries()[2]!.id)).toEqual(before);
    });

    it("matches the Default library case-insensitively and other names exactly", () => {
      expectApiError(
        () => service.importLibrary(document({ library: { name: "dEFAULT", metadata: {} } })),
        409,
        "invalid_state",
      );
      expectApiError(
        () => service.importLibrary(document({ library: { name: "Custom", metadata: {} } })),
        409,
        "invalid_state",
      );
      expect(libraryNames()).toEqual(["Default", "Custom"]);
      // Anything other than Default is exact: a differently-cased name is new.
      const result = service.importLibrary(document({ library: { name: "custom", metadata: {} } }));
      expect(result.mode).toBe("create");
      expect(libraryNames()).toEqual(["Default", "Custom", "custom"]);
    });

    it("imports as a suffixed copy without default keys", () => {
      service.importLibrary(document());
      const second = service.importLibrary(document({ onConflict: "copy" }));
      const third = service.importLibrary(document({ onConflict: "copy" }));
      expect(second.mode).toBe("copy");
      expect(second.library.name).toBe("Team (2)");
      expect(third.library.name).toBe("Team (3)");
      expect(second.created).toEqual({ categories: 2, prompts: 3 });

      const exported = service.exportLibrary(defaultLibrary.id);
      const copy = service.importLibrary({ ...exported, onConflict: "copy" });
      expect(copy.library.name).toBe("Default (2)");
      expect(copy.library.defaultKey).toBeNull();
      for (const { prompt } of service.listPrompts({ libraryId: copy.library.id })) {
        expect(prompt.defaultKey).toBeNull();
      }
      for (const category of service.listCategories({ libraryId: copy.library.id })) {
        expect(category.defaultKey).toBeNull();
      }
    });

    it("append adds missing rows after the existing ones and is idempotent", () => {
      const library = service.createLibrary({ name: "Team" });
      const ops = service.createCategory({
        libraryId: library.id,
        name: "Ops",
        description: "kept",
      });
      const existing = service.createPrompt({
        libraryId: library.id,
        name: "Plan",
        body: "old body",
        categoryIds: [ops.id],
      });
      service.recordPromptUse(existing.prompt.id);

      const first = service.importLibrary(document({ onConflict: "append" }));
      expect(first.mode).toBe("append");
      expect(first.library.id).toBe(library.id);
      expect(first.created).toEqual({ categories: 1, prompts: 2 });
      expect(first.updated).toEqual({ categories: 0, prompts: 0 });
      expect(first.skipped).toEqual({ prompts: 1 });

      const categories = service.listCategories({ libraryId: library.id });
      expect(categories.map((category) => [category.name, category.position, category.description])).toEqual([
        ["Ops", 0, "kept"],
        ["Planning", 1, "Before code"],
      ]);
      const rows = service.listPrompts({ libraryId: library.id });
      expect(rows.map(({ prompt }) => [prompt.name, prompt.position])).toEqual([
        ["Plan", 0],
        ["Deploy", 1],
        ["Loose", 2],
      ]);
      const plan = rows[0]!;
      expect(plan.prompt.body).toBe("old body");
      expect(plan.prompt.usageCount).toBe(1);
      expect(plan.categoryIds).toEqual([ops.id]);
      expect(rows[1]!.categoryIds).toEqual([ops.id]);

      const snapshot = snapshotLibrary(library.id);
      const second = service.importLibrary(document({ onConflict: "append" }));
      expect(second.created).toEqual({ categories: 0, prompts: 0 });
      expect(second.skipped).toEqual({ prompts: 3 });
      expect(snapshotLibrary(library.id)).toEqual(snapshot);
    });

    it("replace overwrites matched rows in place and leaves the rest alone", () => {
      const library = service.createLibrary({ name: "Team" });
      const ops = service.createCategory({
        libraryId: library.id,
        name: "Ops",
        description: "old",
        metadata: { old: true },
      });
      const untouched = service.createPrompt({
        libraryId: library.id,
        name: "Untouched",
        body: "stays",
        categoryIds: [ops.id],
      });
      const existing = service.createPrompt({
        libraryId: library.id,
        name: "Plan",
        body: "old body",
        note: "old note",
        categoryIds: [ops.id],
      });
      service.recordPromptUse(existing.prompt.id);

      const result = service.importLibrary(document({ onConflict: "replace" }));
      expect(result.mode).toBe("replace");
      expect(result.created).toEqual({ categories: 1, prompts: 2 });
      expect(result.updated).toEqual({ categories: 1, prompts: 1 });
      expect(result.skipped).toEqual({ prompts: 0 });

      const opsAfter = service.getCategory(ops.id);
      expect(opsAfter).toMatchObject({ name: "Ops", description: null, metadata: { color: "red" }, position: 0 });
      const planning = service
        .listCategories({ libraryId: library.id })
        .find((category) => category.name === "Planning")!;

      const plan = service.getPrompt(existing.prompt.id);
      expect(plan.prompt).toMatchObject({
        name: "Plan",
        body: "Plan {{TASK}}",
        note: "Use first",
        position: 1,
        usageCount: 1,
      });
      expect(plan.categoryIds).toEqual([ops.id, planning.id]);
      expect(service.getPrompt(untouched.prompt.id)).toEqual(untouched);
      expect(
        service.listPrompts({ libraryId: library.id }).map(({ prompt }) => prompt.name),
      ).toEqual(["Untouched", "Plan", "Deploy", "Loose"]);
    });

    it("replace keeps default keys in Default so restore still reverts the edit", () => {
      const seed = defaultPrompts[0]!;
      const result = service.importLibrary({
        ...document({ onConflict: "replace" }),
        library: { name: "Default", metadata: {} },
        categories: [],
        prompts: [{ name: seed.name, body: "edited", note: null, metadata: {}, categories: [] }],
      });
      expect(result.library.id).toBe(defaultLibrary.id);
      expect(result.updated).toEqual({ categories: 0, prompts: 1 });

      const edited = service
        .listPrompts({ libraryId: defaultLibrary.id })
        .find(({ prompt }) => prompt.defaultKey === seed.defaultKey)!;
      expect(edited.prompt.body).toBe("edited");
      expect(edited.categoryIds).toEqual([]);

      const restored = service.restoreDefaults();
      expect(restored.restored).toContain(`prompt:${seed.defaultKey}`);
      expect(service.getPrompt(edited.prompt.id).prompt.body).toBe(seed.body);
    });

    it("append may add user rows to Default", () => {
      const before = service.listPrompts({ libraryId: defaultLibrary.id }).length;
      const result = service.importLibrary({
        ...document({ onConflict: "append" }),
        library: { name: "Default", metadata: {} },
      });
      expect(result.library.id).toBe(defaultLibrary.id);
      // "Planning" is a shipped default category, so only "Ops" is new.
      expect(result.created).toEqual({ categories: 1, prompts: 3 });
      expect(service.listPrompts({ libraryId: defaultLibrary.id })).toHaveLength(before + 3);
      expect(service.getDefaultLibrary().metadata).toEqual({});
    });

    it("rejects ambiguous prompt names before writing anything", () => {
      const library = service.createLibrary({ name: "Team" });
      const inFile = document({
        onConflict: "append",
        prompts: [
          { name: "Dup", body: "a", note: null, metadata: {}, categories: [] },
          { name: "Dup", body: "b", note: null, metadata: {}, categories: [] },
        ],
      });
      let caught: unknown;
      try {
        service.importLibrary(inFile);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(ApiError);
      expect((caught as ApiError).status).toBe(409);
      expect((caught as ApiError).details).toEqual({
        conflict: "ambiguous_prompt_names",
        inFile: ["Dup"],
        inLibrary: [],
      });
      expect(snapshotLibrary(library.id)).toEqual({ categories: [], prompts: [] });

      service.createPrompt({ libraryId: library.id, name: "Twin", body: "1" });
      service.createPrompt({ libraryId: library.id, name: "Twin", body: "2" });
      try {
        service.importLibrary(document({ onConflict: "replace" }));
      } catch (error) {
        caught = error;
      }
      expect((caught as ApiError).details).toEqual({
        conflict: "ambiguous_prompt_names",
        inFile: [],
        inLibrary: ["Twin"],
      });
      expect(service.listPrompts({ libraryId: library.id })).toHaveLength(2);

      // Copy has no name-based matching, so the same file goes through.
      const copy = service.importLibrary({ ...inFile, onConflict: "copy" });
      expect(copy.library.name).toBe("Team (2)");
      expect(copy.created.prompts).toBe(2);
    });
  });
});
