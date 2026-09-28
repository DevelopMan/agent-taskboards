import type { Prompt, PromptCategory } from "../../domain/types";

export interface PromptGroup {
  category: PromptCategory | null;
  prompts: Prompt[];
}

// Both the Prompt Manager and the Prompt Picker load every library at once
// and narrow to the selected one on the client. These two helpers are that
// narrowing, so every group, count, filter, and reorder below receives rows
// from a single library. A null library (nothing loaded yet) scopes to
// nothing rather than to everything.
export function promptsInLibrary(prompts: Prompt[], libraryId: string | null): Prompt[] {
  return libraryId === null
    ? []
    : prompts.filter((prompt) => prompt.libraryId === libraryId);
}

export function categoriesInLibrary(
  categories: PromptCategory[],
  libraryId: string | null,
): PromptCategory[] {
  return libraryId === null
    ? []
    : categories.filter((category) => category.libraryId === libraryId);
}

// Groups prompts by category in category order; prompts with no category
// come last as the root-level group (category: null). A prompt linked to
// several categories appears in each of them.
export function groupPromptsByCategory(
  prompts: Prompt[],
  categories: PromptCategory[],
): PromptGroup[] {
  const groups: PromptGroup[] = categories.map((category) => ({
    category,
    prompts: prompts.filter((prompt) => prompt.categoryIds.includes(category.id)),
  }));

  const rootLevel = prompts.filter((prompt) => prompt.categoryIds.length === 0);
  if (rootLevel.length > 0) {
    groups.push({ category: null, prompts: rootLevel });
  }

  return groups.filter((group) => group.category !== null || group.prompts.length > 0);
}

export function recentPrompts(prompts: Prompt[], limit: number): Prompt[] {
  return prompts
    .filter((prompt) => prompt.lastUsedAt !== null)
    .sort((a, b) => new Date(b.lastUsedAt!).getTime() - new Date(a.lastUsedAt!).getTime())
    .slice(0, Math.max(0, limit));
}

export function filterPrompts(prompts: Prompt[], query: string): Prompt[] {
  const needle = query.trim().toLowerCase();
  if (!needle) {
    return prompts;
  }

  return prompts.filter(
    (prompt) =>
      prompt.name.toLowerCase().includes(needle) ||
      prompt.body.toLowerCase().includes(needle),
  );
}

export interface PickerPromptView {
  // Every prompt of the selected library, in library order: the list drag
  // reorder plans are built from, whatever the filter shows.
  prompts: Prompt[];
  filtered: Prompt[];
  recent: Prompt[];
  groups: PromptGroup[];
}

// The Prompt Picker shows one library at a time. `Recent` is drawn from that
// library only and is hidden while a filter is active; empty category groups
// are dropped so a filter never leaves bare headings behind.
export function pickerPromptView({
  prompts,
  categories,
  libraryId,
  query,
  recentLimit,
}: {
  prompts: Prompt[];
  categories: PromptCategory[];
  libraryId: string | null;
  query: string;
  recentLimit: number;
}): PickerPromptView {
  const scoped = promptsInLibrary(prompts, libraryId);
  const filtered = filterPrompts(scoped, query);
  return {
    prompts: scoped,
    filtered,
    recent: query.trim() ? [] : recentPrompts(scoped, recentLimit),
    groups: groupPromptsByCategory(
      filtered,
      categoriesInLibrary(categories, libraryId),
    ).filter((group) => group.prompts.length > 0),
  };
}

export function promptCountByCategory(prompts: Prompt[]): Map<string | null, number> {
  const counts = new Map<string | null, number>();
  for (const prompt of prompts) {
    if (prompt.categoryIds.length === 0) {
      counts.set(null, (counts.get(null) ?? 0) + 1);
      continue;
    }
    for (const categoryId of prompt.categoryIds) {
      counts.set(categoryId, (counts.get(categoryId) ?? 0) + 1);
    }
  }
  return counts;
}

// The picker renders one prompt in several places at once: in the `Recent`
// group and again in every category it is linked to. Row state such as the
// expanded preview must therefore be keyed by group plus prompt, not by the
// prompt id alone, or clicking one row would toggle its twins as well.
export const recentPromptGroupKey = "recent";

export function promptGroupKey(category: PromptCategory | null): string {
  return category ? `category:${category.id}` : "root";
}

export function promptRowKey(groupKey: string, promptId: string): string {
  return `${groupKey}/${promptId}`;
}
