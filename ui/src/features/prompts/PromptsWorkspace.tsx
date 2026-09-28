import {
  useMemo,
  useState,
  type DragEvent,
  type KeyboardEvent,
} from "react";
import { ConfirmDialog, Topbar } from "../../components/layout";
import {
  Button,
  EmptyState,
  Icon,
  InlineError,
  Mono,
  SkeletonRows,
} from "../../components/ui";
import type { Prompt, PromptLibrary } from "../../domain/types";
import { apiMessage } from "../../lib/errors";
import { formatDate } from "../../lib/format";
import {
  persistLibraryId,
  promptManagerLibraryStorageKey,
  resolveSelectedLibrary,
  storedLibraryId,
} from "./prompt-library-selection";
import {
  categoriesInLibrary,
  promptCountByCategory,
  promptsInLibrary,
} from "./prompt-library-view";
import {
  dropEdge,
  planAdjacentReorder,
  planReorder,
  promptCategoryDragType,
  promptDragType,
} from "./prompt-reorder";
import { usePromptLibrary } from "./usePromptLibrary";

type PromptFilter =
  | { type: "all" }
  | { type: "root" }
  | { type: "category"; categoryId: string };

interface PromptDraft {
  promptId: string | null;
  name: string;
  body: string;
  // An empty string means "no note"; it is normalized to null on save.
  note: string;
  categoryIds: string[];
}

// One inline name input serves both the trailing `+` pill (libraryId null)
// and a pill being renamed, so at most one of them is open at a time.
interface LibraryNameDraft {
  libraryId: string | null;
  name: string;
}

export function PromptsWorkspace() {
  const library = usePromptLibrary();
  const [filter, setFilter] = useState<PromptFilter>({ type: "all" });
  const [draft, setDraft] = useState<PromptDraft | null>(null);
  // Display toggle only: the note saves through the form's Save button like
  // the name and body do, not on its own.
  const [noteEditing, setNoteEditing] = useState(false);
  const [mutationError, setMutationError] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [pendingDeletePrompt, setPendingDeletePrompt] = useState<Prompt | null>(null);
  const [pendingDeleteCategoryId, setPendingDeleteCategoryId] = useState<string | null>(null);
  const [categoryNameDraft, setCategoryNameDraft] = useState<string | null>(null);
  const [creatingCategory, setCreatingCategory] = useState(false);
  const [newCategoryName, setNewCategoryName] = useState("");
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dropTargetId, setDropTargetId] = useState<string | null>(null);
  const [selectedLibraryId, setSelectedLibraryId] = useState<string | null>(() =>
    storedLibraryId(promptManagerLibraryStorageKey),
  );
  const [libraryNameDraft, setLibraryNameDraft] = useState<LibraryNameDraft | null>(null);
  const [pendingDeleteLibraryId, setPendingDeleteLibraryId] = useState<string | null>(null);

  // The selected pill scopes everything below it. A remembered id that no
  // longer exists resolves to Default on every render, so a library deleted
  // elsewhere never leaves the workspace pointing at nothing.
  const selectedLibrary = resolveSelectedLibrary(library.libraries, selectedLibraryId);
  const libraryId = selectedLibrary?.id ?? null;
  const prompts = useMemo(
    () => promptsInLibrary(library.prompts, libraryId),
    [library.prompts, libraryId],
  );
  const categories = useMemo(
    () => categoriesInLibrary(library.categories, libraryId),
    [library.categories, libraryId],
  );

  const counts = useMemo(
    () => promptCountByCategory(prompts),
    [prompts],
  );

  const visiblePrompts = useMemo(() => {
    if (filter.type === "root") {
      return prompts.filter((prompt) => prompt.categoryIds.length === 0);
    }
    if (filter.type === "category") {
      return prompts.filter((prompt) =>
        prompt.categoryIds.includes(filter.categoryId),
      );
    }
    return prompts;
  }, [filter, prompts]);

  const selectedCategory =
    filter.type === "category"
      ? categories.find((category) => category.id === filter.categoryId) ?? null
      : null;

  const selectedPrompt =
    draft?.promptId != null
      ? prompts.find((prompt) => prompt.id === draft.promptId) ?? null
      : null;

  const draftDirty = draft
    ? draft.promptId === null ||
      !selectedPrompt ||
      draft.name !== selectedPrompt.name ||
      draft.body !== selectedPrompt.body ||
      draft.note !== (selectedPrompt.note ?? "") ||
      draft.categoryIds.join(",") !== selectedPrompt.categoryIds.join(",")
    : false;

  const showStatus = (message: string) => {
    setStatusMessage(message);
    window.setTimeout(() => setStatusMessage(null), 2400);
  };

  const resetDraftTo = (prompt: Prompt) => {
    setMutationError(null);
    setNoteEditing(false);
    setDraft({
      promptId: prompt.id,
      name: prompt.name,
      body: prompt.body,
      note: prompt.note ?? "",
      categoryIds: prompt.categoryIds,
    });
  };

  // Unsaved edits must never be discarded by a stray click on another prompt;
  // Cancel stays the explicit escape hatch. An untouched new draft is free to
  // discard.
  const draftBlocksSwitching = () => {
    if (!draft || !draftDirty) {
      return false;
    }
    if (
      draft.promptId === null &&
      !draft.name.trim() &&
      !draft.body.trim() &&
      !draft.note.trim()
    ) {
      return false;
    }
    showStatus("Unsaved changes — save or cancel the open prompt first");
    return true;
  };

  const openPrompt = (prompt: Prompt) => {
    if (draft?.promptId === prompt.id) {
      return;
    }
    if (draftBlocksSwitching()) {
      return;
    }
    resetDraftTo(prompt);
  };

  const openNewPrompt = () => {
    if (draftBlocksSwitching()) {
      return;
    }
    setMutationError(null);
    setNoteEditing(false);
    setDraft({
      promptId: null,
      name: "",
      body: "",
      note: "",
      categoryIds: filter.type === "category" ? [filter.categoryId] : [],
    });
  };

  const saveDraft = async () => {
    if (!draft || saving) {
      return;
    }
    const name = draft.name.trim();
    if (!name || !draft.body.trim()) {
      setMutationError("Prompt name and body are required");
      return;
    }
    if (draft.promptId === null && !libraryId) {
      setMutationError("No prompt library is available yet");
      return;
    }

    const note = draft.note.trim() || null;

    setSaving(true);
    setMutationError(null);
    setNoteEditing(false);
    try {
      if (draft.promptId === null) {
        const created = await library.createPrompt({
          libraryId: libraryId!,
          name,
          body: draft.body,
          note,
          categoryIds: draft.categoryIds,
        });
        setDraft({
          promptId: created.id,
          name: created.name,
          body: created.body,
          note: created.note ?? "",
          categoryIds: created.categoryIds,
        });
        showStatus("Prompt created");
      } else {
        const updated = await library.updatePrompt(draft.promptId, {
          name,
          body: draft.body,
          note,
          categoryIds: draft.categoryIds,
        });
        setDraft({
          promptId: updated.id,
          name: updated.name,
          body: updated.body,
          note: updated.note ?? "",
          categoryIds: updated.categoryIds,
        });
        showStatus("Prompt updated");
      }
    } catch (cause) {
      setMutationError(apiMessage(cause));
    } finally {
      setSaving(false);
    }
  };

  // Cmd+Enter on Mac, Ctrl+Enter elsewhere, bound on the form so every field
  // inside it answers the shortcut. The editor's Note and Body textareas
  // swallow plain Enter, so without this the only keyboard save is from the
  // single-line fields, where implicit form submission already works.
  const submitOnShortcut = (
    event: KeyboardEvent<HTMLFormElement>,
    submit: () => void,
  ) => {
    if (event.key !== "Enter" || !(event.metaKey || event.ctrlKey)) {
      return;
    }
    event.preventDefault();
    submit();
  };

  const toggleDraftCategory = (categoryId: string) => {
    setDraft((current) => {
      if (!current) {
        return current;
      }
      const categoryIds = current.categoryIds.includes(categoryId)
        ? current.categoryIds.filter((id) => id !== categoryId)
        : [...current.categoryIds, categoryId];
      return { ...current, categoryIds };
    });
  };

  const createCategory = async () => {
    const name = newCategoryName.trim();
    if (!name || !libraryId) {
      return;
    }
    setMutationError(null);
    try {
      const category = await library.createCategory({ libraryId, name });
      setCreatingCategory(false);
      setNewCategoryName("");
      setFilter({ type: "category", categoryId: category.id });
    } catch (cause) {
      setMutationError(apiMessage(cause));
    }
  };

  const renameCategory = async () => {
    if (!selectedCategory || categoryNameDraft === null) {
      return;
    }
    const name = categoryNameDraft.trim();
    if (!name || name === selectedCategory.name) {
      setCategoryNameDraft(null);
      return;
    }
    setMutationError(null);
    try {
      await library.updateCategory(selectedCategory.id, { name });
      setCategoryNameDraft(null);
      showStatus("Category renamed");
    } catch (cause) {
      setMutationError(apiMessage(cause));
    }
  };

  const restoreDefaults = async () => {
    if (restoring) {
      return;
    }
    setRestoring(true);
    setMutationError(null);
    try {
      const restored = await library.restoreDefaults();
      showStatus(
        restored.length === 0
          ? "Defaults already up to date"
          : `Updated ${restored.length} default ${restored.length === 1 ? "entry" : "entries"}`,
      );
    } catch (cause) {
      setMutationError(apiMessage(cause));
    } finally {
      setRestoring(false);
    }
  };

  // Every open draft belongs to the current library (new prompts are created
  // in it, and the list only shows its prompts), so a permitted switch always
  // closes the draft. Dirty edits block the switch exactly as they block
  // opening another prompt; Cancel stays the only discard path.
  const selectLibrary = (target: PromptLibrary) => {
    if (target.id === libraryId) {
      return;
    }
    if (draftBlocksSwitching()) {
      return;
    }
    setSelectedLibraryId(target.id);
    persistLibraryId(promptManagerLibraryStorageKey, target.id);
    setFilter({ type: "all" });
    setDraft(null);
    setNoteEditing(false);
    setLibraryNameDraft(null);
    setCategoryNameDraft(null);
    setCreatingCategory(false);
    setNewCategoryName("");
  };

  const startLibraryRename = (target: PromptLibrary) => {
    if (target.isDefault) {
      return;
    }
    setMutationError(null);
    setLibraryNameDraft({ libraryId: target.id, name: target.name });
  };

  // The input closes before the request goes out: a blur fired by the input
  // leaving the DOM must not read as a cancel, and the pill shows the old
  // name for the few milliseconds until the reload lands.
  const submitLibraryName = async () => {
    if (!libraryNameDraft) {
      return;
    }
    const name = libraryNameDraft.name.trim();
    const current = libraryNameDraft.libraryId
      ? library.libraries.find((item) => item.id === libraryNameDraft.libraryId) ?? null
      : null;
    setLibraryNameDraft(null);
    if (!name || (current && name === current.name)) {
      return;
    }
    setMutationError(null);
    try {
      if (current) {
        await library.renameLibrary(current.id, { name });
        showStatus("Library renamed");
      } else {
        const created = await library.createLibrary({ name });
        selectLibrary(created);
        showStatus("Library created");
      }
    } catch (cause) {
      setMutationError(apiMessage(cause));
    }
  };

  const libraryNameKeys = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      event.preventDefault();
      void submitLibraryName();
    } else if (event.key === "Escape") {
      event.stopPropagation();
      setLibraryNameDraft(null);
    }
  };

  const pendingDeleteLibrary =
    pendingDeleteLibraryId !== null
      ? library.libraries.find((item) => item.id === pendingDeleteLibraryId) ?? null
      : null;
  // Counts come from the loaded rows, which the dialog names before the
  // server cascades the delete.
  const pendingDeleteLibraryCounts = pendingDeleteLibrary
    ? {
        prompts: promptsInLibrary(library.prompts, pendingDeleteLibrary.id).length,
        categories: categoriesInLibrary(library.categories, pendingDeleteLibrary.id).length,
      }
    : null;

  // Prompts carry one order per library, so a drop inside a category view is
  // resolved against the library's full list, never against the filtered
  // rows. Both lists are already scoped to the selected library.
  const orderedIds = (kind: "prompt" | "category") =>
    kind === "prompt"
      ? prompts.map((prompt) => prompt.id)
      : categories.map((category) => category.id);

  const applyPlan = (
    kind: "prompt" | "category",
    plan: { id: string; position: number } | null,
  ) => {
    if (!plan) {
      return;
    }
    if (kind === "prompt") {
      void library.reorderPrompt(plan.id, plan.position);
    } else {
      void library.reorderCategory(plan.id, plan.position);
    }
  };

  const reorderTo = (
    kind: "prompt" | "category",
    draggedId: string,
    targetId: string,
  ) => {
    const plan = planReorder({ ids: orderedIds(kind), draggedId, targetId });
    applyPlan(kind, plan);
  };

  const dragProps = (kind: "prompt" | "category", id: string) => {
    const dragType = kind === "prompt" ? promptDragType : promptCategoryDragType;
    return {
      draggable: true,
      onDragStart: (event: DragEvent<HTMLElement>) => {
        event.dataTransfer.setData(dragType, id);
        event.dataTransfer.effectAllowed = "move";
        setDraggingId(id);
      },
      onDragEnd: () => {
        setDraggingId(null);
        setDropTargetId(null);
      },
      onDragOver: (event: DragEvent<HTMLElement>) => {
        if (!event.dataTransfer.types.includes(dragType)) {
          return;
        }
        event.preventDefault();
        setDropTargetId(id);
      },
      onDragLeave: () => {
        setDropTargetId((current) => (current === id ? null : current));
      },
      onDrop: (event: DragEvent<HTMLElement>) => {
        const draggedId = event.dataTransfer.getData(dragType);
        if (!draggedId) {
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        setDraggingId(null);
        setDropTargetId(null);
        reorderTo(kind, draggedId, id);
      },
    };
  };

  const rowClassName = (
    base: string,
    kind: "prompt" | "category",
    id: string,
  ) => {
    const classes = [base];
    if (draggingId === id) {
      classes.push(`${base}--dragging`);
    }
    if (dropTargetId === id) {
      const edge = dropEdge(orderedIds(kind), draggingId, id);
      if (edge) {
        classes.push(`${base}--drop-${edge}`);
      }
    }
    return classes.join(" ");
  };

  // Alt+Arrow is the pointer-free path to the same reorder, stepping one
  // visible row at a time.
  const reorderByKeyboard = (
    kind: "prompt" | "category",
    id: string,
    event: KeyboardEvent<HTMLElement>,
  ) => {
    if (!event.altKey || (event.key !== "ArrowUp" && event.key !== "ArrowDown")) {
      return;
    }
    const ids = orderedIds(kind);
    const plan = planAdjacentReorder({
      ids,
      visibleIds:
        kind === "prompt" ? visiblePrompts.map((prompt) => prompt.id) : ids,
      id,
      delta: event.key === "ArrowUp" ? -1 : 1,
    });
    event.preventDefault();
    applyPlan(kind, plan);
  };

  const pendingDeleteCategory =
    pendingDeleteCategoryId !== null
      ? categories.find((category) => category.id === pendingDeleteCategoryId) ?? null
      : null;

  return (
    <>
      <Topbar
        actions={
          <>
            {selectedLibrary?.isDefault && (
              <Button
                disabled={restoring || library.loading}
                icon={<Icon name="refresh" />}
                onClick={() => void restoreDefaults()}
                variant="ghost"
              >
                Restore defaults
              </Button>
            )}
            <Button
              disabled={library.loading}
              icon={<Icon name="plus" />}
              onClick={openNewPrompt}
              variant="primary"
            >
              New prompt
            </Button>
          </>
        }
        crumbs={[{ label: "Prompts", icon: <Icon name="prompt" /> }]}
      />
      <div aria-label="Prompt libraries" className="prompts-libraries" role="group">
        {library.libraries.map((item) => {
          const active = item.id === libraryId;
          if (libraryNameDraft?.libraryId === item.id) {
            return (
              <span
                className="prompts-library prompts-library--active prompts-library--editing"
                key={item.id}
              >
                <input
                  aria-label={`Rename library ${item.name}`}
                  autoFocus
                  className="prompts-library__input"
                  onBlur={() => setLibraryNameDraft(null)}
                  onChange={(event) =>
                    setLibraryNameDraft((current) =>
                      current ? { ...current, name: event.target.value } : current,
                    )
                  }
                  onKeyDown={libraryNameKeys}
                  value={libraryNameDraft.name}
                />
              </span>
            );
          }
          return (
            <span
              className={active ? "prompts-library prompts-library--active" : "prompts-library"}
              key={item.id}
            >
              <button
                aria-pressed={active}
                className="prompts-library__select"
                onClick={() => selectLibrary(item)}
                onDoubleClick={() => startLibraryRename(item)}
                onKeyDown={(event) => {
                  if (event.key === "F2") {
                    event.preventDefault();
                    startLibraryRename(item);
                  }
                }}
                title={
                  item.isDefault
                    ? "The Default library ships the system catalog and cannot be renamed or deleted"
                    : "Double-click or press F2 to rename"
                }
                type="button"
              >
                {item.name}
              </button>
              {!item.isDefault && (
                <button
                  aria-label={`Delete library ${item.name}`}
                  className="prompts-library__remove"
                  onClick={() => setPendingDeleteLibraryId(item.id)}
                  title="Delete library"
                  type="button"
                >
                  <Icon name="close" size={10} />
                </button>
              )}
            </span>
          );
        })}
        {libraryNameDraft?.libraryId === null ? (
          <span className="prompts-library prompts-library--editing">
            <input
              aria-label="New library name"
              autoFocus
              className="prompts-library__input"
              onBlur={() => setLibraryNameDraft(null)}
              onChange={(event) =>
                setLibraryNameDraft((current) =>
                  current ? { ...current, name: event.target.value } : current,
                )
              }
              onKeyDown={libraryNameKeys}
              placeholder="Library name"
              value={libraryNameDraft.name}
            />
          </span>
        ) : (
          <button
            aria-label="New library"
            className="prompts-libraries__add"
            disabled={library.loading}
            onClick={() => {
              setMutationError(null);
              setLibraryNameDraft({ libraryId: null, name: "" });
            }}
            title="New library"
            type="button"
          >
            <Icon name="plus" size={12} />
          </button>
        )}
      </div>
      <InlineError message={library.error ?? mutationError} />
      <div className="prompts-layout">
        <aside className="prompts-rail">
          <div className="prompts-rail__heading">
            <span>Categories</span>
            <button
              className="icon-btn"
              onClick={() => {
                setCreatingCategory((current) => !current);
                setNewCategoryName("");
              }}
              title="New category"
              type="button"
            >
              <Icon name="plus" />
            </button>
          </div>
          {creatingCategory && (
            <form
              className="prompts-rail__new-category"
              onKeyDown={(event) => submitOnShortcut(event, () => void createCategory())}
              onSubmit={(event) => {
                event.preventDefault();
                void createCategory();
              }}
            >
              <input
                aria-label="New category name"
                autoFocus
                onChange={(event) => setNewCategoryName(event.target.value)}
                placeholder="Category name"
                value={newCategoryName}
              />
              <Button type="submit" variant="outline" disabled={!newCategoryName.trim()}>
                Add
              </Button>
            </form>
          )}
          <nav className="prompts-rail__items">
            <PromptFilterItem
              active={filter.type === "all"}
              count={prompts.length}
              label="All prompts"
              onClick={() => setFilter({ type: "all" })}
            />
            <PromptFilterItem
              active={filter.type === "root"}
              count={counts.get(null) ?? 0}
              label="Uncategorized"
              onClick={() => setFilter({ type: "root" })}
            />
            {categories.map((category) => (
              <div
                className={rowClassName("prompts-rail__drag", "category", category.id)}
                key={category.id}
                {...dragProps("category", category.id)}
              >
                <PromptFilterItem
                  active={filter.type === "category" && filter.categoryId === category.id}
                  count={counts.get(category.id) ?? 0}
                  label={category.name}
                  onClick={() => setFilter({ type: "category", categoryId: category.id })}
                  onKeyDown={(event) => reorderByKeyboard("category", category.id, event)}
                  title="Drag or press Alt+Up/Down to reorder"
                />
              </div>
            ))}
          </nav>
        </aside>
        <section className="prompts-list">
          <div className="prompts-list__heading">
            {selectedCategory && categoryNameDraft !== null ? (
              <form
                className="prompts-list__rename"
                onKeyDown={(event) => submitOnShortcut(event, () => void renameCategory())}
                onSubmit={(event) => {
                  event.preventDefault();
                  void renameCategory();
                }}
              >
                <input
                  aria-label="Category name"
                  autoFocus
                  onChange={(event) => setCategoryNameDraft(event.target.value)}
                  value={categoryNameDraft}
                />
                <Button type="submit" variant="outline">Save</Button>
                <Button onClick={() => setCategoryNameDraft(null)} type="button" variant="ghost">
                  Cancel
                </Button>
              </form>
            ) : (
              <>
                <h2>
                  {filter.type === "all" && "All prompts"}
                  {filter.type === "root" && "Uncategorized"}
                  {selectedCategory?.name}
                </h2>
                {statusMessage && <Mono faded>{statusMessage}</Mono>}
                <span className="prompts-list__spacer" />
                {selectedCategory && (
                  <>
                    <button
                      className="prompts-list__action"
                      onClick={() => setCategoryNameDraft(selectedCategory.name)}
                      type="button"
                    >
                      Rename
                    </button>
                    <button
                      className="prompts-list__action prompts-list__action--danger"
                      onClick={() => setPendingDeleteCategoryId(selectedCategory.id)}
                      type="button"
                    >
                      Delete
                    </button>
                  </>
                )}
              </>
            )}
          </div>
          {library.loading && <SkeletonRows />}
          {!library.loading && visiblePrompts.length === 0 && (
            <EmptyState
              action={
                <Button icon={<Icon name="plus" />} onClick={openNewPrompt} variant="outline">
                  New prompt
                </Button>
              }
              body="Prompts you save here can be copied from any task via the prompt picker."
              title="No prompts here yet"
            />
          )}
          <div className="prompts-list__items">
            {visiblePrompts.map((prompt) => (
              // The row is dragged by its wrapper: browsers handle a
              // draggable <button> inconsistently, and the button stays the
              // click and focus target.
              <div
                className={rowClassName("prompt-row-drag", "prompt", prompt.id)}
                key={prompt.id}
                {...dragProps("prompt", prompt.id)}
              >
                <button
                  className={
                    draft?.promptId === prompt.id
                      ? "prompt-row prompt-row--active"
                      : "prompt-row"
                  }
                  onClick={() => openPrompt(prompt)}
                  onKeyDown={(event) => reorderByKeyboard("prompt", prompt.id, event)}
                  title="Drag or press Alt+Up/Down to reorder"
                  type="button"
                >
                  <span className="prompt-row__name">{prompt.name}</span>
                  <span className="prompt-row__meta">
                    {prompt.usageCount > 0 && (
                      <Mono faded>
                        used {prompt.usageCount}× · {formatDate(prompt.lastUsedAt)}
                      </Mono>
                    )}
                    {prompt.usageCount === 0 && <Mono faded>never used</Mono>}
                  </span>
                </button>
              </div>
            ))}
          </div>
        </section>
        <section className="prompt-editor">
          {!draft && (
            <EmptyState
              body="Select a prompt from the list or create a new one to edit it here."
              title="No prompt selected"
            />
          )}
          {draft && (
            <form
              className="prompt-editor__form"
              onKeyDown={(event) =>
                submitOnShortcut(event, () => {
                  // Mirrors the Save button's disabled state, so the shortcut
                  // never fires a redundant save.
                  if (saving || !draftDirty) {
                    return;
                  }
                  void saveDraft();
                })
              }
              onSubmit={(event) => {
                event.preventDefault();
                void saveDraft();
              }}
            >
              <label className="field">
                <span className="field__label">Name</span>
                <input
                  onChange={(event) =>
                    setDraft((current) =>
                      current ? { ...current, name: event.target.value } : current,
                    )
                  }
                  placeholder="Prompt name (emoji welcome)"
                  value={draft.name}
                />
              </label>
              <div className="field">
                <span className="field__label">Note</span>
                {noteEditing ? (
                  <textarea
                    autoFocus
                    className="prompt-editor__note-input"
                    onBlur={() => setNoteEditing(false)}
                    onChange={(event) =>
                      setDraft((current) =>
                        current ? { ...current, note: event.target.value } : current,
                      )
                    }
                    onKeyDown={(event) => {
                      if (event.key === "Escape") {
                        // Collapse back to static text without letting the key
                        // reach the workspace; Cancel stays the discard path.
                        event.stopPropagation();
                        setNoteEditing(false);
                      }
                    }}
                    placeholder="A short help text from the prompt's author..."
                    rows={3}
                    value={draft.note}
                  />
                ) : (
                  <button
                    className={
                      draft.note.trim()
                        ? "prompt-editor__note"
                        : "prompt-editor__note prompt-editor__note--empty"
                    }
                    onClick={() => setNoteEditing(true)}
                    title="Edit the note"
                    type="button"
                  >
                    {draft.note.trim() ? draft.note : "Add a note"}
                  </button>
                )}
              </div>
              <label className="field prompt-editor__body-field">
                <span className="field__label">
                  Body
                  <Mono faded>
                    {" {{TASK}}, {{PARENT_TASK}}, {{BOARD}}, {{PROJECT}} are replaced on copy"}
                  </Mono>
                </span>
                <textarea
                  className="prompt-editor__body"
                  onChange={(event) =>
                    setDraft((current) =>
                      current ? { ...current, body: event.target.value } : current,
                    )
                  }
                  placeholder="Prompt text..."
                  value={draft.body}
                />
              </label>
              <div className="prompt-editor__categories">
                <span className="field__label">Categories</span>
                {categories.length === 0 && (
                  <Mono faded>No categories yet</Mono>
                )}
                {categories.map((category) => (
                  <label className="prompt-editor__category" key={category.id}>
                    <input
                      checked={draft.categoryIds.includes(category.id)}
                      onChange={() => toggleDraftCategory(category.id)}
                      type="checkbox"
                    />
                    <span>{category.name}</span>
                  </label>
                ))}
              </div>
              <div className="form-actions">
                {selectedPrompt && (
                  <Button
                    icon={<Icon name="trash" />}
                    onClick={() => setPendingDeletePrompt(selectedPrompt)}
                    type="button"
                    variant="danger"
                  >
                    Delete
                  </Button>
                )}
                <span className="prompt-editor__actions-spacer" />
                <Button
                  disabled={saving || !draftDirty}
                  onClick={() => {
                    if (selectedPrompt) {
                      resetDraftTo(selectedPrompt);
                    } else {
                      setDraft(null);
                    }
                  }}
                  type="button"
                  variant="ghost"
                >
                  Cancel
                </Button>
                <Button
                  disabled={saving || !draftDirty}
                  title={`${draft.promptId === null ? "Create" : "Save"} (Cmd/Ctrl+Enter)`}
                  type="submit"
                  variant="primary"
                >
                  {saving ? "Saving" : draft.promptId === null ? "Create" : "Save"}
                </Button>
              </div>
            </form>
          )}
        </section>
      </div>
      {pendingDeletePrompt && (
        <ConfirmDialog
          confirmLabel="Delete"
          danger
          message={
            <p>
              This permanently deletes the prompt “{pendingDeletePrompt.name}”.
              {pendingDeletePrompt.defaultKey
                ? " It is a default prompt and can be brought back with Restore defaults."
                : " This cannot be undone."}
            </p>
          }
          onCancel={() => setPendingDeletePrompt(null)}
          onConfirm={async () => {
            await library.deletePrompt(pendingDeletePrompt.id);
            if (draft?.promptId === pendingDeletePrompt.id) {
              setDraft(null);
            }
            setPendingDeletePrompt(null);
          }}
          title="Delete prompt?"
        />
      )}
      {pendingDeleteCategory && (
        <ConfirmDialog
          confirmLabel="Delete category"
          danger
          message={
            <p>
              This deletes the category “{pendingDeleteCategory.name}”. Prompts in it
              are kept and fall back to the root level.
            </p>
          }
          onCancel={() => setPendingDeleteCategoryId(null)}
          onConfirm={async () => {
            await library.deleteCategory(pendingDeleteCategory.id);
            // The deleted id would make an open draft unsaveable ("category
            // not found"), so drop it from the draft as the server did.
            setDraft((current) =>
              current
                ? {
                    ...current,
                    categoryIds: current.categoryIds.filter(
                      (id) => id !== pendingDeleteCategory.id,
                    ),
                  }
                : current,
            );
            setPendingDeleteCategoryId(null);
            setFilter({ type: "all" });
          }}
          title="Delete category?"
        />
      )}
      {pendingDeleteLibrary && pendingDeleteLibraryCounts && (
        <ConfirmDialog
          confirmLabel="Delete library"
          danger
          message={
            <p>
              This permanently deletes the library “{pendingDeleteLibrary.name}” together
              with its {countLabel(pendingDeleteLibraryCounts.prompts, "prompt")} and{" "}
              {countLabel(pendingDeleteLibraryCounts.categories, "category", "categories")}.
              This cannot be undone.
            </p>
          }
          onCancel={() => setPendingDeleteLibraryId(null)}
          onConfirm={async () => {
            await library.deleteLibrary(pendingDeleteLibrary.id);
            setPendingDeleteLibraryId(null);
            if (pendingDeleteLibrary.id === libraryId) {
              // The open draft, if any, lived in the deleted library and is
              // gone with it; nothing here is worth an unsaved-changes stop.
              const fallback = library.defaultLibrary?.id ?? null;
              setSelectedLibraryId(fallback);
              persistLibraryId(promptManagerLibraryStorageKey, fallback);
              setFilter({ type: "all" });
              setDraft(null);
              setNoteEditing(false);
            }
          }}
          title="Delete library?"
        />
      )}
    </>
  );
}

function countLabel(count: number, singular: string, plural = `${singular}s`) {
  return `${count} ${count === 1 ? singular : plural}`;
}

function PromptFilterItem({
  active,
  count,
  label,
  onClick,
  onKeyDown,
  title,
}: {
  active: boolean;
  count: number;
  label: string;
  onClick: () => void;
  onKeyDown?: (event: KeyboardEvent<HTMLElement>) => void;
  title?: string;
}) {
  return (
    <button
      className={active ? "prompts-rail__item prompts-rail__item--active" : "prompts-rail__item"}
      onClick={onClick}
      onKeyDown={onKeyDown}
      title={title}
      type="button"
    >
      <span className="prompts-rail__item-label">{label}</span>
      <Mono faded>{count}</Mono>
    </button>
  );
}
