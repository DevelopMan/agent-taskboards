import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type RefObject,
} from "react";
import { Icon, InlineError, Mono, SkeletonRows } from "../../components/ui";
import type { Board, Project, Prompt, PromptLibrary, Task } from "../../domain/types";
import { api } from "../../lib/api";
import { copyTextToClipboard } from "../../lib/clipboard";
import { buildNamedReferenceText } from "../../lib/entity-reference";
import { buildTaskReferenceText } from "../../lib/task-reference";
import { resolveParentTaskId } from "./parent-task";
import {
  persistLibraryId,
  promptPickerLibraryStorageKey,
  resolveSelectedLibrary,
  storedLibraryId,
} from "./prompt-library-selection";
import {
  pickerPromptView,
  promptGroupKey,
  promptRowKey,
  recentPromptGroupKey,
} from "./prompt-library-view";
import { dropEdge, planReorder, promptDragType } from "./prompt-reorder";
import { renderPromptBody, type PromptTokenValues } from "./prompt-tokens";
import { usePromptLibrary } from "./usePromptLibrary";

const recentPromptLimit = 3;

export function PromptPicker({
  board,
  boardTasks,
  onClose,
  panelRef,
  project,
  task,
}: {
  board: Board | null;
  boardTasks: Task[];
  onClose: () => void;
  panelRef: RefObject<HTMLElement | null>;
  project: Project | null;
  task: Task;
}) {
  const library = usePromptLibrary();
  const [query, setQuery] = useState("");
  const [selectedLibraryId, setSelectedLibraryId] = useState<string | null>(() =>
    storedLibraryId(promptPickerLibraryStorageKey),
  );
  // Row state is keyed by row, not by prompt: the same prompt is rendered in
  // `Recent` and in each of its categories, and only the clicked row should
  // react. See `promptRowKey`.
  const [expandedRowKey, setExpandedRowKey] = useState<string | null>(null);
  const [copiedRowKey, setCopiedRowKey] = useState<string | null>(null);
  const [copyError, setCopyError] = useState<string | null>(null);
  const [draggingPromptId, setDraggingPromptId] = useState<string | null>(null);
  const [dropTargetRowKey, setDropTargetRowKey] = useState<string | null>(null);
  const [parentTaskValue, setParentTaskValue] = useState<string | null>(null);
  const copiedBlinkTimeout = useRef<number | null>(null);

  const parentTaskId = useMemo(
    () => resolveParentTaskId(task)?.taskId ?? null,
    [task],
  );
  const boardTasksRef = useRef(boardTasks);
  boardTasksRef.current = boardTasks;

  useEffect(() => {
    // Clear any previous task's parent immediately so a copy issued while the
    // async lookup is in flight never renders a stale parent reference.
    setParentTaskValue(null);
    if (!parentTaskId) {
      return;
    }

    const onBoard = boardTasksRef.current.find(
      (boardTask) => boardTask.id === parentTaskId,
    );
    if (onBoard) {
      setParentTaskValue(
        buildTaskReferenceText(onBoard.title, onBoard.title, onBoard.id),
      );
      return;
    }

    let cancelled = false;
    api
      .getTask(parentTaskId)
      .then((parentTask) => {
        if (!cancelled) {
          setParentTaskValue(
            buildTaskReferenceText(parentTask.title, parentTask.title, parentTask.id),
          );
        }
      })
      .catch(() => {
        // The parent id resolved but the task is gone or unreachable; keep the
        // id visible so the pasted prompt is still actionable.
        if (!cancelled) {
          setParentTaskValue(`( id=${parentTaskId} )`);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [parentTaskId]);

  useEffect(() => {
    return () => {
      if (copiedBlinkTimeout.current) {
        window.clearTimeout(copiedBlinkTimeout.current);
      }
    };
  }, []);

  const tokenValues = useMemo<PromptTokenValues>(() => {
    const values: PromptTokenValues = {
      TASK: buildTaskReferenceText(task.title, task.title, task.id),
    };
    if (parentTaskValue) {
      values.PARENT_TASK = parentTaskValue;
    }
    // The picker only opens over an open task, so its board and project are
    // already loaded: no lookup, unlike the parent task above.
    if (board) {
      values.BOARD = buildNamedReferenceText(board.name, board.id);
    }
    if (project) {
      values.PROJECT = buildNamedReferenceText(project.name, project.id);
    }
    return values;
  }, [
    board,
    parentTaskValue,
    project,
    task.id,
    task.title,
  ]);

  const copyPrompt = async (prompt: Prompt, rowKey: string) => {
    setCopyError(null);
    const rendered = renderPromptBody(prompt.body, tokenValues);
    if (!(await copyTextToClipboard(rendered))) {
      setCopyError("Unable to copy the prompt to the clipboard");
      return;
    }

    if (copiedBlinkTimeout.current) {
      window.clearTimeout(copiedBlinkTimeout.current);
    }
    setCopiedRowKey(rowKey);
    copiedBlinkTimeout.current = window.setTimeout(
      () => setCopiedRowKey(null),
      850,
    );
    void library.recordPromptUse(prompt.id).catch(() => {
      // Usage tracking is best-effort; the copy already succeeded.
    });
  };

  // The selected pill scopes everything below it. A remembered id that no
  // longer exists resolves to Default on every render, so a library deleted
  // in the Manager never leaves the picker pointing at nothing.
  const selectedLibrary = resolveSelectedLibrary(library.libraries, selectedLibraryId);
  const libraryId = selectedLibrary?.id ?? null;
  const {
    prompts,
    filtered: filteredPrompts,
    recent,
    groups,
  } = useMemo(
    () =>
      pickerPromptView({
        prompts: library.prompts,
        categories: library.categories,
        libraryId,
        query,
        recentLimit: recentPromptLimit,
      }),
    [library.prompts, library.categories, libraryId, query],
  );

  // Row state belongs to the rows of the library being left; the filter is
  // kept so one term can be tried across libraries.
  const selectLibrary = (target: PromptLibrary) => {
    if (target.id === libraryId) {
      return;
    }
    setSelectedLibraryId(target.id);
    persistLibraryId(promptPickerLibraryStorageKey, target.id);
    if (copiedBlinkTimeout.current) {
      window.clearTimeout(copiedBlinkTimeout.current);
      copiedBlinkTimeout.current = null;
    }
    setExpandedRowKey(null);
    setCopiedRowKey(null);
    setCopyError(null);
    setDraggingPromptId(null);
    setDropTargetRowKey(null);
  };

  // Dragging writes the library's one global order, so it is suppressed while
  // the filter hides rows: the resulting order would be hard to predict.
  const reorderEnabled = !query.trim();

  const dragProps = (promptId: string, rowKey: string) => ({
    draggable: true,
    onDragStart: (event: DragEvent<HTMLElement>) => {
      event.dataTransfer.setData(promptDragType, promptId);
      event.dataTransfer.effectAllowed = "move";
      setDraggingPromptId(promptId);
    },
    onDragEnd: () => {
      setDraggingPromptId(null);
      setDropTargetRowKey(null);
    },
    onDragOver: (event: DragEvent<HTMLElement>) => {
      if (!event.dataTransfer.types.includes(promptDragType)) {
        return;
      }
      event.preventDefault();
      setDropTargetRowKey(rowKey);
    },
    onDragLeave: () => {
      setDropTargetRowKey((current) => (current === rowKey ? null : current));
    },
    onDrop: (event: DragEvent<HTMLElement>) => {
      const draggedId = event.dataTransfer.getData(promptDragType);
      if (!draggedId) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      setDraggingPromptId(null);
      setDropTargetRowKey(null);
      const plan = planReorder({
        ids: prompts.map((item) => item.id),
        draggedId,
        targetId: promptId,
      });
      if (plan) {
        void library.reorderPrompt(plan.id, plan.position);
      }
    },
  });

  const renderRow = (
    prompt: Prompt,
    groupKey: string,
    reorderable = reorderEnabled,
  ) => {
    const rowKey = promptRowKey(groupKey, prompt.id);
    const copied = copiedRowKey === rowKey;
    const expanded = expandedRowKey === rowKey;
    const classNames = ["prompt-picker__row"];
    if (copied) {
      classNames.push("prompt-picker__row--copied");
    }
    if (reorderable && draggingPromptId === prompt.id) {
      classNames.push("prompt-picker__row--dragging");
    }
    if (reorderable && dropTargetRowKey === rowKey) {
      const edge = dropEdge(
        prompts.map((item) => item.id),
        draggingPromptId,
        prompt.id,
      );
      if (edge) {
        classNames.push(`prompt-picker__row--drop-${edge}`);
      }
    }

    return (
      <div
        className={classNames.join(" ")}
        key={rowKey}
        {...(reorderable ? dragProps(prompt.id, rowKey) : {})}
      >
        <button
          className="prompt-picker__copy"
          onClick={() => void copyPrompt(prompt, rowKey)}
          title="Copy prompt to clipboard"
          type="button"
        >
          <Icon name="copy" size={12} />
          <span className="prompt-picker__name">{prompt.name}</span>
          {copied && <Mono faded>copied</Mono>}
        </button>
        <button
          aria-expanded={expanded}
          aria-label={`Preview prompt ${prompt.name}`}
          className="icon-btn prompt-picker__expand"
          onClick={() =>
            setExpandedRowKey((current) => (current === rowKey ? null : rowKey))
          }
          title="Preview prompt"
          type="button"
        >
          <Icon
            className={
              expanded
                ? "prompt-picker__chevron prompt-picker__chevron--open"
                : "prompt-picker__chevron"
            }
            name="chevron"
            size={12}
          />
        </button>
        {expanded && (
          <pre className="prompt-picker__preview">
            {renderPromptBody(prompt.body, tokenValues)}
          </pre>
        )}
        {expanded && prompt.note && (
          // The author's note is commentary, not prompt text: it is shown
          // verbatim, outside the preview box, and never copied.
          <p className="prompt-picker__note">{prompt.note}</p>
        )}
      </div>
    );
  };

  return (
    <aside
      aria-label="Prompt picker"
      className="prompt-picker"
      ref={(element) => {
        panelRef.current = element;
      }}
    >
      <div className="prompt-picker__top">
        <span className="prompt-picker__title">
          <Icon name="prompt" />
          Prompts
        </span>
        <button className="icon-btn" onClick={onClose} title="Close prompt picker" type="button">
          <Icon name="close" />
        </button>
      </div>
      {library.libraries.length > 1 && (
        // Read-only: libraries are created, renamed, and deleted in the
        // Manager. With a single library there is nothing to choose, so the
        // row stays out of the narrow rail.
        <div
          aria-label="Prompt libraries"
          className="prompt-picker__libraries"
          role="group"
        >
          {library.libraries.map((item) => {
            const active = item.id === libraryId;
            return (
              <span
                className={
                  active ? "prompts-library prompts-library--active" : "prompts-library"
                }
                key={item.id}
              >
                <button
                  aria-pressed={active}
                  className="prompts-library__select"
                  onClick={() => selectLibrary(item)}
                  title={item.name}
                  type="button"
                >
                  {item.name}
                </button>
              </span>
            );
          })}
        </div>
      )}
      <input
        aria-label="Filter prompts"
        className="prompt-picker__filter"
        onChange={(event) => setQuery(event.target.value)}
        placeholder="Filter prompts..."
        value={query}
      />
      <InlineError message={library.error ?? copyError} />
      {library.loading && <SkeletonRows />}
      {!library.loading && selectedLibrary === null && (
        <div className="prompt-picker__empty">
          No prompts yet. Add some in the Prompts section.
        </div>
      )}
      {!library.loading && selectedLibrary !== null && prompts.length === 0 && (
        <div className="prompt-picker__empty">No prompts in this library yet.</div>
      )}
      {!library.loading && filteredPrompts.length === 0 && prompts.length > 0 && (
        <div className="prompt-picker__empty">No prompts match the filter.</div>
      )}
      <div className="prompt-picker__groups">
        {recent.length > 0 && (
          <section className="prompt-picker__group">
            <h3>Recent</h3>
            {recent.map((prompt) =>
              renderRow(prompt, recentPromptGroupKey, false),
            )}
          </section>
        )}
        {groups.map((group) => (
          <section className="prompt-picker__group" key={group.category?.id ?? "root"}>
            <h3>{group.category?.name ?? "Uncategorized"}</h3>
            {group.prompts.map((prompt) =>
              renderRow(prompt, promptGroupKey(group.category)),
            )}
          </section>
        ))}
      </div>
    </aside>
  );
}
