import { afterEach, describe, expect, it, vi } from "vitest";
import { persistPromptPickerVisible, storedPromptPickerVisible } from "./task-prompt-picker-visibility";

const storageKey = "taskboards.task.promptPickerVisible";

describe("task prompt picker visibility preference", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("shows the picker by default and after an invalid stored value", () => {
    const values = new Map<string, string>();
    vi.stubGlobal("window", { localStorage: storage(values) });

    expect(storedPromptPickerVisible()).toBe(true);
    values.set(storageKey, "hidden");
    expect(storedPromptPickerVisible()).toBe(true);
  });

  it("restores both closed and reopened states", () => {
    const values = new Map<string, string>();
    vi.stubGlobal("window", { localStorage: storage(values) });

    persistPromptPickerVisible(false);
    expect(values.get(storageKey)).toBe("false");
    expect(storedPromptPickerVisible()).toBe(false);

    persistPromptPickerVisible(true);
    expect(values.get(storageKey)).toBe("true");
    expect(storedPromptPickerVisible()).toBe(true);
  });

  it("keeps the default and allows toggles when storage is unavailable", () => {
    vi.stubGlobal("window", {
      localStorage: {
        getItem: () => { throw new Error("unavailable"); },
        setItem: () => { throw new Error("unavailable"); },
      },
    });

    expect(storedPromptPickerVisible()).toBe(true);
    expect(() => persistPromptPickerVisible(false)).not.toThrow();
  });
});

function storage(values: Map<string, string>) {
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
  };
}
