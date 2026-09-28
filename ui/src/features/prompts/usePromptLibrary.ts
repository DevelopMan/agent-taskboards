import { useCallback, useEffect, useRef, useState } from "react";
import type {
  Prompt,
  PromptCategory,
  PromptLibrary,
  PromptLibraryDeleteResponse,
} from "../../domain/types";
import { api } from "../../lib/api";
import { apiMessage } from "../../lib/errors";
import { reorderItemsInLibrary } from "./prompt-reorder";

// The hook loads every library with all of its categories and prompts once;
// the Manager and the Picker narrow to their selected library on the client
// (see `promptsInLibrary`), so switching pills never refetches.
export interface PromptLibraryState {
  libraries: PromptLibrary[];
  defaultLibrary: PromptLibrary | null;
  categories: PromptCategory[];
  prompts: Prompt[];
  loading: boolean;
  error: string | null;
  reload: () => Promise<void>;
  createLibrary: (input: { name: string }) => Promise<PromptLibrary>;
  renameLibrary: (libraryId: string, input: { name: string }) => Promise<PromptLibrary>;
  deleteLibrary: (libraryId: string) => Promise<PromptLibraryDeleteResponse>;
  createCategory: (input: {
    libraryId: string;
    name: string;
    description?: string | null;
  }) => Promise<PromptCategory>;
  updateCategory: (
    categoryId: string,
    input: { name?: string; description?: string | null },
  ) => Promise<PromptCategory>;
  deleteCategory: (categoryId: string) => Promise<void>;
  createPrompt: (input: {
    libraryId: string;
    name: string;
    body: string;
    note?: string | null;
    categoryIds?: string[];
  }) => Promise<Prompt>;
  updatePrompt: (
    promptId: string,
    input: {
      name?: string;
      body?: string;
      note?: string | null;
      categoryIds?: string[];
    },
  ) => Promise<Prompt>;
  deletePrompt: (promptId: string) => Promise<void>;
  reorderPrompt: (promptId: string, position: number) => Promise<void>;
  reorderCategory: (categoryId: string, position: number) => Promise<void>;
  recordPromptUse: (promptId: string) => Promise<void>;
  restoreDefaults: () => Promise<string[]>;
}

export function usePromptLibrary(): PromptLibraryState {
  const [libraries, setLibraries] = useState<PromptLibrary[]>([]);
  const [categories, setCategories] = useState<PromptCategory[]>([]);
  const [prompts, setPrompts] = useState<Prompt[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Reordering reads the current list without re-creating its callback on
  // every load, so the drag handlers keep a stable identity.
  const categoriesRef = useRef<PromptCategory[]>([]);
  const promptsRef = useRef<Prompt[]>([]);
  categoriesRef.current = categories;
  promptsRef.current = prompts;

  const reload = useCallback(async () => {
    setError(null);
    try {
      const [nextLibraries, nextCategories, nextPrompts] = await Promise.all([
        api.listPromptLibraries(),
        api.listPromptCategories(),
        api.listPrompts(),
      ]);
      setLibraries(nextLibraries);
      setCategories(nextCategories);
      setPrompts(nextPrompts);
    } catch (cause) {
      setError(apiMessage(cause));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const createLibrary = useCallback(
    async (input: { name: string }) => {
      const library = await api.createPromptLibrary(input);
      await reload();
      return library;
    },
    [reload],
  );

  const renameLibrary = useCallback(
    async (libraryId: string, input: { name: string }) => {
      const library = await api.renamePromptLibrary(libraryId, input);
      await reload();
      return library;
    },
    [reload],
  );

  const deleteLibrary = useCallback(
    async (libraryId: string) => {
      const result = await api.deletePromptLibrary(libraryId);
      await reload();
      return result;
    },
    [reload],
  );

  const createCategory = useCallback(
    async (input: { libraryId: string; name: string; description?: string | null }) => {
      const category = await api.createPromptCategory(input);
      await reload();
      return category;
    },
    [reload],
  );

  const updateCategory = useCallback(
    async (
      categoryId: string,
      input: { name?: string; description?: string | null },
    ) => {
      const category = await api.updatePromptCategory(categoryId, input);
      await reload();
      return category;
    },
    [reload],
  );

  const deleteCategory = useCallback(
    async (categoryId: string) => {
      await api.deletePromptCategory(categoryId);
      await reload();
    },
    [reload],
  );

  const createPrompt = useCallback(
    async (input: {
      libraryId: string;
      name: string;
      body: string;
      note?: string | null;
      categoryIds?: string[];
    }) => {
      const prompt = await api.createPrompt(input);
      await reload();
      return prompt;
    },
    [reload],
  );

  const updatePrompt = useCallback(
    async (
      promptId: string,
      input: {
        name?: string;
        body?: string;
        note?: string | null;
        categoryIds?: string[];
      },
    ) => {
      const prompt = await api.updatePrompt(promptId, input);
      await reload();
      return prompt;
    },
    [reload],
  );

  const deletePrompt = useCallback(
    async (promptId: string) => {
      await api.deletePrompt(promptId);
      await reload();
    },
    [reload],
  );

  // Both reorders paint the new order locally first so the dragged row does
  // not snap back, then reconcile against the server's renormalized
  // positions. A failed call restores the pre-drag order. `position` is an
  // index into the moved row's library, matching the server, so the local
  // mirror touches that library only.
  const reorderPrompt = useCallback(
    async (promptId: string, position: number) => {
      const previous = promptsRef.current;
      setPrompts(reorderItemsInLibrary(previous, promptId, position));
      try {
        await api.reorderPrompt(promptId, position);
        await reload();
      } catch (cause) {
        setPrompts(previous);
        setError(apiMessage(cause));
      }
    },
    [reload],
  );

  const reorderCategory = useCallback(
    async (categoryId: string, position: number) => {
      const previous = categoriesRef.current;
      setCategories(reorderItemsInLibrary(previous, categoryId, position));
      try {
        await api.reorderPromptCategory(categoryId, position);
        await reload();
      } catch (cause) {
        setCategories(previous);
        setError(apiMessage(cause));
      }
    },
    [reload],
  );

  const recordPromptUse = useCallback(async (promptId: string) => {
    const prompt = await api.recordPromptUse(promptId);
    setPrompts((current) =>
      current.map((item) => (item.id === prompt.id ? prompt : item)),
    );
  }, []);

  // The restore response carries only the Default library's rows, so the
  // other libraries are refetched rather than overwritten.
  const restoreDefaults = useCallback(async () => {
    const result = await api.restorePromptDefaults();
    await reload();
    return result.restored;
  }, [reload]);

  return {
    libraries,
    defaultLibrary: libraries.find((library) => library.isDefault) ?? null,
    categories,
    prompts,
    loading,
    error,
    reload,
    createLibrary,
    renameLibrary,
    deleteLibrary,
    createCategory,
    updateCategory,
    deleteCategory,
    createPrompt,
    updatePrompt,
    deletePrompt,
    reorderPrompt,
    reorderCategory,
    recordPromptUse,
    restoreDefaults,
  };
}
