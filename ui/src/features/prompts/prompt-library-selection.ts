import type { PromptLibrary } from "../../domain/types";

// The Manager and the Picker are different contexts, so each remembers its
// own library pill under its own key.
export const promptManagerLibraryStorageKey = "taskboards.prompts.libraryId";
export const promptPickerLibraryStorageKey = "taskboards.task.promptPickerLibraryId";

export function storedLibraryId(key: string): string | null {
  if (typeof window === "undefined") {
    return null;
  }

  try {
    const value = window.localStorage.getItem(key);
    return value && value.trim() ? value : null;
  } catch {
    return null;
  }
}

export function persistLibraryId(key: string, libraryId: string | null) {
  try {
    if (libraryId === null) {
      window.localStorage.removeItem(key);
    } else {
      window.localStorage.setItem(key, libraryId);
    }
  } catch {
    // Preference persistence should never block the prompts UI.
  }
}

// A remembered id that no longer exists (the library was deleted, or the
// value is stale or corrupt) falls back to the Default library, and then to
// whatever comes first. Null only while no libraries are loaded.
export function resolveSelectedLibrary(
  libraries: PromptLibrary[],
  storedId: string | null,
): PromptLibrary | null {
  if (storedId !== null) {
    const stored = libraries.find((library) => library.id === storedId);
    if (stored) {
      return stored;
    }
  }
  return (
    libraries.find((library) => library.isDefault) ?? libraries[0] ?? null
  );
}
