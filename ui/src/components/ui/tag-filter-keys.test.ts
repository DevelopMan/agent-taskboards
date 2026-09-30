import { describe, expect, it } from "vitest";
import { tagTabAction } from "./tag-filter-keys";

const typed = { highlight: 0, menuOpen: true, shift: false, text: "ui" };

describe("tag filter Tab key", () => {
  it("adds the only suggestion", () => {
    expect(tagTabAction({ ...typed, suggestionCount: 1 })).toEqual({ type: "add", index: 0 });
  });

  it("cycles the highlight through several suggestions in both directions", () => {
    expect(tagTabAction({ ...typed, suggestionCount: 3 })).toEqual({ type: "highlight", index: 1 });
    expect(tagTabAction({ ...typed, highlight: 2, suggestionCount: 3 })).toEqual({ type: "highlight", index: 0 });
    expect(tagTabAction({ ...typed, shift: true, suggestionCount: 3 })).toEqual({ type: "highlight", index: 2 });
  });

  it("keeps normal focus movement without typed text, an open menu, or suggestions", () => {
    expect(tagTabAction({ ...typed, text: "  ", suggestionCount: 3 })).toEqual({ type: "default" });
    expect(tagTabAction({ ...typed, menuOpen: false, suggestionCount: 3 })).toEqual({ type: "default" });
    expect(tagTabAction({ ...typed, suggestionCount: 0 })).toEqual({ type: "default" });
  });
});
