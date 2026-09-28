import { afterEach, describe, expect, it, vi } from "vitest";
import type { PromptLibrary } from "../../domain/types";
import {
  persistLibraryId,
  promptManagerLibraryStorageKey,
  promptPickerLibraryStorageKey,
  resolveSelectedLibrary,
  storedLibraryId,
} from "./prompt-library-selection";

function library(overrides: Partial<PromptLibrary> = {}): PromptLibrary {
  return {
    id: "lib_1",
    name: "Library",
    position: 0,
    defaultKey: null,
    isDefault: false,
    metadata: {},
    createdAt: null,
    updatedAt: null,
    ...overrides,
  };
}

const defaultLibrary = library({
  id: "prompt-library-default",
  name: "Default",
  defaultKey: "default",
  isDefault: true,
});
const custom = library({ id: "prompt-library-custom", name: "Custom", position: 1 });
const experiments = library({ id: "lib_exp", name: "🧪 Experiments", position: 2 });

describe("resolveSelectedLibrary", () => {
  it("returns the stored library when it still exists", () => {
    expect(
      resolveSelectedLibrary([defaultLibrary, custom, experiments], "lib_exp"),
    ).toBe(experiments);
  });

  it("falls back to Default when the stored id is missing or unknown", () => {
    const libraries = [custom, defaultLibrary, experiments];

    expect(resolveSelectedLibrary(libraries, null)).toBe(defaultLibrary);
    expect(resolveSelectedLibrary(libraries, "deleted-library")).toBe(defaultLibrary);
  });

  it("falls back to the first library when there is no Default", () => {
    expect(resolveSelectedLibrary([custom, experiments], "nope")).toBe(custom);
  });

  it("is null while no libraries are loaded", () => {
    expect(resolveSelectedLibrary([], "lib_exp")).toBeNull();
    expect(resolveSelectedLibrary([], null)).toBeNull();
  });
});

describe("library selection storage", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("keeps the Manager and Picker selections apart", () => {
    const values = new Map<string, string>();
    vi.stubGlobal("window", { localStorage: storage(values) });

    persistLibraryId(promptManagerLibraryStorageKey, "lib_a");
    persistLibraryId(promptPickerLibraryStorageKey, "lib_b");

    expect(storedLibraryId(promptManagerLibraryStorageKey)).toBe("lib_a");
    expect(storedLibraryId(promptPickerLibraryStorageKey)).toBe("lib_b");
  });

  it("treats a missing, blank, or removed value as no selection", () => {
    const values = new Map<string, string>();
    vi.stubGlobal("window", { localStorage: storage(values) });

    expect(storedLibraryId(promptManagerLibraryStorageKey)).toBeNull();

    values.set(promptManagerLibraryStorageKey, "   ");
    expect(storedLibraryId(promptManagerLibraryStorageKey)).toBeNull();

    persistLibraryId(promptManagerLibraryStorageKey, "lib_a");
    persistLibraryId(promptManagerLibraryStorageKey, null);
    expect(values.has(promptManagerLibraryStorageKey)).toBe(false);
    expect(storedLibraryId(promptManagerLibraryStorageKey)).toBeNull();
  });

  it("resolves a corrupt stored value to Default", () => {
    const values = new Map<string, string>([
      [promptPickerLibraryStorageKey, '{"not":"an id"}'],
    ]);
    vi.stubGlobal("window", { localStorage: storage(values) });

    const stored = storedLibraryId(promptPickerLibraryStorageKey);
    expect(resolveSelectedLibrary([custom, defaultLibrary], stored)).toBe(defaultLibrary);
  });

  it("survives unavailable storage", () => {
    vi.stubGlobal("window", {
      localStorage: {
        getItem: () => { throw new Error("unavailable"); },
        setItem: () => { throw new Error("unavailable"); },
        removeItem: () => { throw new Error("unavailable"); },
      },
    });

    expect(storedLibraryId(promptManagerLibraryStorageKey)).toBeNull();
    expect(() => persistLibraryId(promptManagerLibraryStorageKey, "lib_a")).not.toThrow();
    expect(() => persistLibraryId(promptManagerLibraryStorageKey, null)).not.toThrow();
  });

  it("is a no-op outside the browser", () => {
    vi.stubGlobal("window", undefined);

    expect(storedLibraryId(promptManagerLibraryStorageKey)).toBeNull();
  });
});

function storage(values: Map<string, string>) {
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  };
}
