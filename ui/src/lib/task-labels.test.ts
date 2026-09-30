import { describe, expect, it } from "vitest";
import {
  countTaskLabels,
  formatTaskLabels,
  parseTaskLabels,
  taskLabelsEqual,
  taskMatchesLabels,
} from "./task-labels";

describe("task label helpers", () => {
  it("trims comma-separated labels and drops empty entries", () => {
    expect(parseTaskLabels(" ui,  tasks ,, frontend, ")).toEqual(["ui", "tasks", "frontend"]);
  });

  it("preserves first-seen order while removing exact duplicates", () => {
    expect(parseTaskLabels("tasks, ui, tasks, UI, ui")).toEqual(["tasks", "ui", "UI"]);
  });

  it("formats stored labels for editing with normalized spacing", () => {
    expect(formatTaskLabels([" ui ", "tasks", "ui", ""])).toBe("ui, tasks");
  });

  it("compares label arrays by order and exact value", () => {
    expect(taskLabelsEqual(["ui", "tasks"], ["ui", "tasks"])).toBe(true);
    expect(taskLabelsEqual(["tasks", "ui"], ["ui", "tasks"])).toBe(false);
  });

  it("returns an empty array when labels are cleared", () => {
    expect(parseTaskLabels(" , , ")).toEqual([]);
  });

  it("matches task labels against all or any selected labels", () => {
    expect(taskMatchesLabels(["api", " ui "], ["ui", "api"], "all")).toBe(true);
    expect(taskMatchesLabels(["api"], ["ui", "api"], "all")).toBe(false);
    expect(taskMatchesLabels(["api"], ["ui", "api"], "any")).toBe(true);
    expect(taskMatchesLabels(["API"], ["api"], "any")).toBe(false);
    expect(taskMatchesLabels([], [], "all")).toBe(true);
  });

  it("counts distinct labels across tasks in case-insensitive order", () => {
    expect(
      countTaskLabels([
        { labels: ["ui", "api", "ui"] },
        { labels: ["Beta", " api "] },
        { labels: ["alpha", ""] },
      ]),
    ).toEqual([
      { label: "alpha", count: 1 },
      { label: "api", count: 2 },
      { label: "Beta", count: 1 },
      { label: "ui", count: 1 },
    ]);
  });
});
