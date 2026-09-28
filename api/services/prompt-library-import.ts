import type { JsonObject } from "../db/schema.js";

// The on-disk shape of one exported prompt library. Array order is position
// order; `prompt.categories` order is the link order. Ids, timestamps,
// default keys, and usage counters are deliberately absent so a file can be
// imported into any database as plain user rows.
export const PROMPT_LIBRARY_EXPORT_FORMAT = "taskboards-prompt-library";
export const PROMPT_LIBRARY_EXPORT_VERSION = 1;

export interface PromptLibraryExportCategory {
  name: string;
  description: string | null;
  metadata: JsonObject;
}

export interface PromptLibraryExportPrompt {
  name: string;
  body: string;
  note: string | null;
  metadata: JsonObject;
  categories: string[];
}

export interface PromptLibraryExportDocument {
  format: typeof PROMPT_LIBRARY_EXPORT_FORMAT;
  version: typeof PROMPT_LIBRARY_EXPORT_VERSION;
  exportedAt: string;
  library: { name: string; metadata: JsonObject };
  categories: PromptLibraryExportCategory[];
  prompts: PromptLibraryExportPrompt[];
}

export type PromptLibraryImportConflictMode = "append" | "replace" | "copy";
export type PromptLibraryImportMode = "create" | PromptLibraryImportConflictMode;

// Picks the smallest free ` (n)` suffix with n >= 2, appended to the full
// incoming name. An existing trailing number is never parsed: "Team (2)"
// becomes "Team (2) (2)" when it is taken.
export function resolveCopiedLibraryName(name: string, taken: Set<string>) {
  for (let n = 2; ; n += 1) {
    const candidate = `${name} (${n})`;
    if (!taken.has(candidate)) {
      return candidate;
    }
  }
}

export interface ExistingNamedRow {
  id: string;
  name: string;
}

export type PromptLibraryMergePlan =
  | {
      ok: false;
      conflict: "ambiguous_prompt_names";
      inFile: string[];
      inLibrary: string[];
    }
  | {
      ok: true;
      categories: {
        create: PromptLibraryExportCategory[];
        update: { id: string; category: PromptLibraryExportCategory }[];
        // Every file category resolved to an existing or to-be-created row,
        // in file order, so link rewrites can look names up after creation.
        matched: { name: string; id: string }[];
      };
      prompts: {
        create: PromptLibraryExportPrompt[];
        update: { id: string; prompt: PromptLibraryExportPrompt }[];
        skip: PromptLibraryExportPrompt[];
      };
    };

// Decides what an append or replace import does to the target library
// without touching the database. Categories and prompts are matched by exact
// name. `append` skips matched prompts, `replace` updates them; both create
// what is missing and never delete. Both modes need prompt names to be
// unique on either side, or a name could not identify one row.
export function planLibraryMerge(
  document: Pick<PromptLibraryExportDocument, "categories" | "prompts">,
  existingCategories: ExistingNamedRow[],
  existingPrompts: ExistingNamedRow[],
  mode: "append" | "replace",
): PromptLibraryMergePlan {
  const inFile = duplicateNames(document.prompts.map((prompt) => prompt.name));
  const inLibrary = duplicateNames(existingPrompts.map((prompt) => prompt.name));
  if (inFile.length > 0 || inLibrary.length > 0) {
    return { ok: false, conflict: "ambiguous_prompt_names", inFile, inLibrary };
  }

  const categoryIdByName = new Map(
    existingCategories.map((category) => [category.name, category.id]),
  );
  const promptIdByName = new Map(
    existingPrompts.map((prompt) => [prompt.name, prompt.id]),
  );

  const categories: Extract<PromptLibraryMergePlan, { ok: true }>["categories"] = {
    create: [],
    update: [],
    matched: [],
  };
  for (const category of document.categories) {
    const id = categoryIdByName.get(category.name);
    if (id === undefined) {
      categories.create.push(category);
      continue;
    }
    categories.matched.push({ name: category.name, id });
    if (mode === "replace") {
      categories.update.push({ id, category });
    }
  }

  const prompts: Extract<PromptLibraryMergePlan, { ok: true }>["prompts"] = {
    create: [],
    update: [],
    skip: [],
  };
  for (const prompt of document.prompts) {
    const id = promptIdByName.get(prompt.name);
    if (id === undefined) {
      prompts.create.push(prompt);
    } else if (mode === "replace") {
      prompts.update.push({ id, prompt });
    } else {
      prompts.skip.push(prompt);
    }
  }

  return { ok: true, categories, prompts };
}

// Names that occur more than once, each listed once, in first-seen order.
function duplicateNames(names: string[]) {
  const seen = new Set<string>();
  const duplicates: string[] = [];
  for (const name of names) {
    if (seen.has(name) && !duplicates.includes(name)) {
      duplicates.push(name);
    }
    seen.add(name);
  }
  return duplicates;
}

// The download file name: the library name reduced to lowercase ASCII words
// joined by hyphens, with a fixed fallback for names that leave nothing.
export function promptLibraryFileName(libraryName: string) {
  const slug = libraryName
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `${slug || "prompt-library"}.prompt-library.json`;
}
