import { describe, expect, it } from "vitest";
import type { PromptLibrary, PromptLibraryImportResult } from "../../domain/types";
import { ApiClientError } from "../../lib/api";
import {
  findLibraryByName,
  importFailureMessage,
  importSummary,
  isLibraryExistsConflict,
  parsePromptLibraryFile,
  promptLibraryFileName,
} from "./prompt-library-export";

const library = (overrides: Partial<PromptLibrary>): PromptLibrary => ({
  id: "lib",
  name: "Lib",
  position: 0,
  defaultKey: null,
  isDefault: false,
  metadata: {},
  createdAt: null,
  updatedAt: null,
  ...overrides,
});

const libraries = [
  library({ id: "default", name: "Default", defaultKey: "default", isDefault: true }),
  library({ id: "team", name: "Team" }),
];

const result = (overrides: Partial<PromptLibraryImportResult>): PromptLibraryImportResult => ({
  library: libraries[1]!,
  mode: "append",
  created: { categories: 0, prompts: 0 },
  updated: { categories: 0, prompts: 0 },
  skipped: { prompts: 0 },
  ...overrides,
});

describe("promptLibraryFileName", () => {
  it("slugs the name and falls back when nothing survives", () => {
    expect(promptLibraryFileName("🧪 Experiments & Ideas")).toBe(
      "experiments-ideas.prompt-library.json",
    );
    expect(promptLibraryFileName("Default")).toBe("default.prompt-library.json");
    expect(promptLibraryFileName("🧪")).toBe("prompt-library.prompt-library.json");
  });
});

describe("parsePromptLibraryFile", () => {
  const valid = {
    format: "taskboards-prompt-library",
    version: 1,
    exportedAt: "2026-09-28T12:00:00.000Z",
    library: { name: "Team", metadata: {} },
    categories: [],
    prompts: [],
  };

  it("accepts a well-formed export", () => {
    const parsed = parsePromptLibraryFile(JSON.stringify(valid));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.document.library.name).toBe("Team");
    }
  });

  it("rejects bad JSON, the wrong format, and missing parts without a request", () => {
    expect(parsePromptLibraryFile("{nope")).toEqual({
      ok: false,
      error: "The file is not valid JSON",
    });
    expect(parsePromptLibraryFile("[]").ok).toBe(false);
    expect(parsePromptLibraryFile(JSON.stringify({ ...valid, format: "other" }))).toEqual({
      ok: false,
      error: "The file is not a Taskboards prompt library export",
    });
    expect(parsePromptLibraryFile(JSON.stringify({ ...valid, version: 2 }))).toEqual({
      ok: false,
      error: "Unsupported prompt library export version 2",
    });
    expect(parsePromptLibraryFile(JSON.stringify({ ...valid, library: { name: " " } })).ok).toBe(
      false,
    );
    expect(parsePromptLibraryFile(JSON.stringify({ ...valid, prompts: null })).ok).toBe(false);
  });
});

describe("findLibraryByName", () => {
  it("matches trimmed names exactly and Default case-insensitively", () => {
    expect(findLibraryByName(libraries, "  Team ")?.id).toBe("team");
    expect(findLibraryByName(libraries, "team")).toBeNull();
    expect(findLibraryByName(libraries, "dEFAULT")?.id).toBe("default");
    expect(findLibraryByName(libraries, "Other")).toBeNull();
  });
});

describe("importSummary", () => {
  it("describes a created library", () => {
    expect(
      importSummary(
        result({ mode: "create", created: { categories: 2, prompts: 5 } }),
      ),
    ).toBe("Created “Team”: 2 categories and 5 prompts added");
  });

  it("describes a merge with every counter", () => {
    expect(
      importSummary(
        result({
          mode: "replace",
          created: { categories: 1, prompts: 1 },
          updated: { categories: 1, prompts: 3 },
          skipped: { prompts: 0 },
        }),
      ),
    ).toBe("Imported into “Team”: 1 category and 1 prompt added, 3 replaced");
  });

  it("says when an append added nothing", () => {
    expect(importSummary(result({ skipped: { prompts: 4 } }))).toBe(
      "Imported into “Team”: 4 skipped",
    );
    expect(importSummary(result({}))).toBe("Imported into “Team”: nothing to add");
  });
});

describe("import failure helpers", () => {
  it("recognises the library_exists conflict", () => {
    const conflict = new ApiClientError(409, "invalid_state", "exists", {
      conflict: "library_exists",
      libraryId: "team",
      name: "Team",
    });
    expect(isLibraryExistsConflict(conflict)).toEqual({ name: "Team" });
    expect(importFailureMessage(conflict)).toBeNull();
    expect(isLibraryExistsConflict(new Error("x"))).toBeNull();
  });

  it("lists ambiguous names from both sides", () => {
    const error = new ApiClientError(409, "invalid_state", "ambiguous", {
      conflict: "ambiguous_prompt_names",
      inFile: ["Plan"],
      inLibrary: ["Review", "Deploy"],
    });
    expect(importFailureMessage(error)).toBe(
      "Append and replace need unique prompt names. Duplicated in the file: Plan; in the library: Review, Deploy. Rename them or import as a copy.",
    );
  });

  it("names the failing path of a shape error", () => {
    const error = new ApiClientError(400, "invalid_request", "Request body is invalid", {
      issues: [{ path: ["prompts", 2, "body"], message: "Body cannot be empty" }],
    });
    expect(importFailureMessage(error)).toBe("Body cannot be empty (at prompts.2.body)");
    expect(importFailureMessage(new Error("plain"))).toBeNull();
  });
});
