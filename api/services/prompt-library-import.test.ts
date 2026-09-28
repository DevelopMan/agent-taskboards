import { describe, expect, it } from "vitest";
import {
  planLibraryMerge,
  promptLibraryFileName,
  resolveCopiedLibraryName,
  type PromptLibraryExportCategory,
  type PromptLibraryExportPrompt,
} from "./prompt-library-import.js";

const category = (
  name: string,
  overrides: Partial<PromptLibraryExportCategory> = {},
): PromptLibraryExportCategory => ({
  name,
  description: null,
  metadata: {},
  ...overrides,
});

const prompt = (
  name: string,
  overrides: Partial<PromptLibraryExportPrompt> = {},
): PromptLibraryExportPrompt => ({
  name,
  body: `${name} body`,
  note: null,
  metadata: {},
  categories: [],
  ...overrides,
});

describe("resolveCopiedLibraryName", () => {
  it("starts at 2 and takes the smallest free number", () => {
    expect(resolveCopiedLibraryName("Team", new Set(["Team"]))).toBe("Team (2)");
    expect(resolveCopiedLibraryName("Team", new Set(["Team", "Team (2)"]))).toBe(
      "Team (3)",
    );
    expect(
      resolveCopiedLibraryName("Team", new Set(["Team", "Team (3)"])),
    ).toBe("Team (2)");
  });

  it("never parses or renumbers an existing trailing number", () => {
    expect(
      resolveCopiedLibraryName("Team (2)", new Set(["Team", "Team (2)"])),
    ).toBe("Team (2) (2)");
  });

  it("suffixes Default like any other name", () => {
    expect(resolveCopiedLibraryName("Default", new Set(["Default"]))).toBe(
      "Default (2)",
    );
  });
});

describe("planLibraryMerge", () => {
  const existingCategories = [
    { id: "cat-planning", name: "Planning" },
    { id: "cat-misc", name: "Misc" },
  ];
  const existingPrompts = [
    { id: "p-plan", name: "Plan" },
    { id: "p-review", name: "Review" },
  ];
  const document = {
    categories: [category("Planning", { description: "new" }), category("Ops")],
    prompts: [
      prompt("Plan", { categories: ["Ops"] }),
      prompt("Deploy", { categories: ["Ops", "Planning"] }),
    ],
  };

  it("append creates what is missing and skips matched prompts", () => {
    const plan = planLibraryMerge(document, existingCategories, existingPrompts, "append");
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.categories.create.map((item) => item.name)).toEqual(["Ops"]);
    expect(plan.categories.update).toEqual([]);
    expect(plan.categories.matched).toEqual([{ name: "Planning", id: "cat-planning" }]);
    expect(plan.prompts.create.map((item) => item.name)).toEqual(["Deploy"]);
    expect(plan.prompts.update).toEqual([]);
    expect(plan.prompts.skip.map((item) => item.name)).toEqual(["Plan"]);
  });

  it("replace updates matched prompts and categories in place", () => {
    const plan = planLibraryMerge(document, existingCategories, existingPrompts, "replace");
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.categories.create.map((item) => item.name)).toEqual(["Ops"]);
    expect(plan.categories.update).toEqual([
      { id: "cat-planning", category: document.categories[0] },
    ]);
    expect(plan.prompts.create.map((item) => item.name)).toEqual(["Deploy"]);
    expect(plan.prompts.update).toEqual([{ id: "p-plan", prompt: document.prompts[0] }]);
    expect(plan.prompts.skip).toEqual([]);
  });

  it("re-planning the same file against its own result is a no-op", () => {
    const plan = planLibraryMerge(
      document,
      [...existingCategories, { id: "cat-ops", name: "Ops" }],
      [...existingPrompts, { id: "p-deploy", name: "Deploy" }],
      "append",
    );
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.categories.create).toEqual([]);
    expect(plan.prompts.create).toEqual([]);
    expect(plan.prompts.skip).toHaveLength(2);
  });

  it("rejects duplicate prompt names in the file", () => {
    const plan = planLibraryMerge(
      { categories: [], prompts: [prompt("Plan"), prompt("Plan"), prompt("Other")] },
      [],
      [],
      "append",
    );
    expect(plan).toEqual({
      ok: false,
      conflict: "ambiguous_prompt_names",
      inFile: ["Plan"],
      inLibrary: [],
    });
  });

  it("rejects duplicate prompt names in the target library", () => {
    const plan = planLibraryMerge(
      { categories: [], prompts: [prompt("Plan")] },
      [],
      [
        { id: "a", name: "Review" },
        { id: "b", name: "Review" },
        { id: "c", name: "Review" },
      ],
      "replace",
    );
    expect(plan).toEqual({
      ok: false,
      conflict: "ambiguous_prompt_names",
      inFile: [],
      inLibrary: ["Review"],
    });
  });

  it("matches names exactly, including case", () => {
    const plan = planLibraryMerge(
      { categories: [category("planning")], prompts: [prompt("plan")] },
      existingCategories,
      existingPrompts,
      "append",
    );
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.categories.create.map((item) => item.name)).toEqual(["planning"]);
    expect(plan.prompts.create.map((item) => item.name)).toEqual(["plan"]);
  });
});

describe("promptLibraryFileName", () => {
  it("slugs the library name", () => {
    expect(promptLibraryFileName("Team")).toBe("team.prompt-library.json");
    expect(promptLibraryFileName("  🧪 Experiments & Ideas (2) ")).toBe(
      "experiments-ideas-2.prompt-library.json",
    );
    expect(promptLibraryFileName("Café Ünïcode")).toBe(
      "cafe-unicode.prompt-library.json",
    );
  });

  it("falls back when nothing survives", () => {
    expect(promptLibraryFileName("🧪")).toBe("prompt-library.prompt-library.json");
  });
});
