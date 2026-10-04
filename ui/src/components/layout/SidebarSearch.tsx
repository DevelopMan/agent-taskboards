import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import type { ProjectTreeItem, SearchResult, SearchSourceType, Task } from "../../domain/types";
import { Icon, Kbd, Mono, type IconName } from "../ui";
import { useSearch, type SearchFilters } from "../../features/search/useSearch";
import { looksLikeTaskId } from "../../features/tasks/task-metadata";

const SIDEBAR_RESULT_LIMIT = 5;
const TASK_ID_SEARCH_MIN_LENGTH = 6;
// A bare task ID suffix (`90rvs4`) only counts when it mixes letters and
// digits, so ordinary 6-letter words still search the scoped project.
const TASK_ID_SUFFIX_PATTERN = /^(?=[a-z0-9]*[0-9])(?=[a-z0-9]*[a-z])[a-z0-9]{6}$/i;

export function SidebarSearch({
  activeBoardId,
  currentBoardTasks,
  onOpenResult,
  onSubmitQuery,
  projectTree,
  scopeProjectId,
}: {
  activeBoardId: string | null;
  currentBoardTasks: Task[];
  onOpenResult: (result: SearchResult) => void;
  onSubmitQuery: (query: string, projectId: string | null) => void;
  projectTree: ProjectTreeItem[];
  scopeProjectId: string | null;
}) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [allProjects, setAllProjects] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const trimmed = query.trim();
  const exactCurrentBoardTask = useMemo(
    () => findCurrentBoardTaskIdMatch(trimmed, currentBoardTasks),
    [currentBoardTasks, trimmed],
  );
  const runSearchApi = shouldRunSidebarSearchApi({
    currentBoardTasks,
    open,
    query: trimmed,
  });
  const scope = useMemo(
    () =>
      resolveSidebarSearchScope({
        allProjects,
        projectTree,
        query: trimmed,
        scopeProjectId,
      }),
    [allProjects, projectTree, scopeProjectId, trimmed],
  );
  const filters = useMemo<SearchFilters>(
    () =>
      buildSidebarSearchFilters({
        activeBoardId,
        projectId: scope.projectId,
      }),
    [activeBoardId, scope.projectId],
  );

  const { results, loading, error, lastQuery, resultFilters } = useSearch({
    query,
    filters,
    enabled: runSearchApi,
  });
  // Rows fetched under another scope must not linger under the new scope row.
  const staleScope = resultFilters !== filters;
  const searching = loading || staleScope;

  const showPopover = open && trimmed.length > 0;
  const visibleResults = useMemo(
    () => (staleScope ? [] : results.slice(0, SIDEBAR_RESULT_LIMIT)),
    [results, staleScope],
  );

  // Widening to all projects lasts only while the popover is showing; clearing
  // the query, Escape, or a click outside starts the next search scoped again.
  useEffect(() => {
    if (!showPopover) {
      setAllProjects(false);
    }
  }, [showPopover]);

  useEffect(() => {
    setHighlight(0);
  }, [lastQuery]);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key !== "/" || event.metaKey || event.ctrlKey || event.altKey) {
        return;
      }
      const target = event.target as HTMLElement | null;
      const tag = target?.tagName;
      if (
        target?.isContentEditable ||
        tag === "INPUT" ||
        tag === "TEXTAREA" ||
        tag === "SELECT"
      ) {
        return;
      }
      event.preventDefault();
      inputRef.current?.focus();
      inputRef.current?.select();
    }

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, []);

  useEffect(() => {
    if (!open) {
      return;
    }
    function handleClick(event: MouseEvent) {
      const target = event.target as Node | null;
      if (rootRef.current && target && !rootRef.current.contains(target)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [open]);

  const crumbLookup = useMemo(() => buildCrumbLookup(projectTree), [projectTree]);

  useEffect(() => {
    if (!open || !exactCurrentBoardTask) {
      return;
    }
    selectResult(taskToSearchResult(exactCurrentBoardTask, "exact"));
  }, [exactCurrentBoardTask, open]);

  function selectResult(result: SearchResult) {
    setOpen(false);
    setQuery("");
    inputRef.current?.blur();
    onOpenResult(result);
  }

  function submitQuery() {
    if (!trimmed) {
      return;
    }
    setOpen(false);
    inputRef.current?.blur();
    onSubmitQuery(trimmed, scope.projectId);
  }

  function handleKeyDown(event: ReactKeyboardEvent<HTMLInputElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      if (query) {
        setQuery("");
      } else {
        setOpen(false);
        inputRef.current?.blur();
      }
      return;
    }

    if (!showPopover || visibleResults.length === 0) {
      if (event.key === "Enter") {
        event.preventDefault();
        submitQuery();
      }
      return;
    }

    if (event.key === "ArrowDown") {
      event.preventDefault();
      setHighlight((current) => (current + 1) % visibleResults.length);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setHighlight(
        (current) => (current - 1 + visibleResults.length) % visibleResults.length,
      );
    } else if (event.key === "Enter") {
      event.preventDefault();
      const target = visibleResults[highlight] ?? visibleResults[0];
      if (target) {
        selectResult(target);
      } else {
        submitQuery();
      }
    }
  }

  return (
    <div className="sidebar__search-root" ref={rootRef}>
      <div className={open ? "sidebar__search sidebar__search--active" : "sidebar__search"}>
        <Icon name="search" />
        <input
          aria-label="Search tasks, boards, comments"
          className="sidebar__search-input"
          onChange={(event) => setQuery(event.target.value)}
          onFocus={() => setOpen(true)}
          onKeyDown={handleKeyDown}
          placeholder="Search..."
          ref={inputRef}
          spellCheck={false}
          type="search"
          value={query}
        />
        {!query && !open && <Kbd>/</Kbd>}
      </div>
      {showPopover && (
        <div className="search-popover" role="listbox">
          {scope.project && (
            <div className="search-popover__scope">
              <span className="search-popover__scope-label">
                {scope.mode === "project" ? (
                  <>
                    In <Mono>{scope.project.name}</Mono>
                  </>
                ) : scope.mode === "task-id" ? (
                  "Task ID in all projects"
                ) : (
                  "All projects"
                )}
              </span>
              {scope.mode !== "task-id" && (
                <button
                  className="search-popover__scope-toggle"
                  // Keep focus in the input so typing and arrow keys continue.
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => setAllProjects((current) => !current)}
                  type="button"
                >
                  {scope.mode === "project" ? "All projects" : "Only this project"}
                </button>
              )}
            </div>
          )}
          {searching && visibleResults.length === 0 && (
            <div className="search-popover__status">Searching...</div>
          )}
          {!searching && error && (
            <div className="search-popover__status search-popover__status--error">{error}</div>
          )}
          {!searching && !error && visibleResults.length === 0 && lastQuery && (
            <div className="search-popover__status">No matches for "{lastQuery}".</div>
          )}
          {visibleResults.map((result, index) => (
            <button
              className={
                index === highlight
                  ? "search-popover__row search-popover__row--active"
                  : "search-popover__row"
              }
              key={result.searchDocumentId}
              onClick={() => selectResult(result)}
              onMouseEnter={() => setHighlight(index)}
              role="option"
              aria-selected={index === highlight}
              type="button"
            >
              <Icon name={iconForSourceType(result.sourceType)} />
              <div className="search-popover__row-body">
                <div className="search-popover__row-title">
                  {result.title ?? fallbackTitle(result.sourceType)}
                </div>
                <div className="search-popover__row-snippet">{result.snippet}</div>
                <Mono faded>{crumbLookup.crumb(result)}</Mono>
              </div>
            </button>
          ))}
          {trimmed && (
            <button
              className="search-popover__footer"
              onClick={submitQuery}
              type="button"
            >
              <Icon name="search" />
              <span>View all results for "{trimmed}"</span>
            </button>
          )}
        </div>
      )}
    </div>
  );
}

type CrumbLookup = {
  crumb: (result: Pick<SearchResult, "projectId" | "boardId">) => string;
};

function buildCrumbLookup(projectTree: ProjectTreeItem[]): CrumbLookup {
  const projectNames = new Map<string, string>();
  const boardNames = new Map<string, string>();
  for (const item of projectTree) {
    projectNames.set(item.project.id, item.project.name);
    for (const board of item.boards) {
      boardNames.set(board.id, board.name);
    }
  }

  return {
    crumb({ projectId, boardId }) {
      const parts: string[] = [];
      if (projectId) {
        parts.push(projectNames.get(projectId) ?? "Project");
      }
      if (boardId) {
        parts.push(boardNames.get(boardId) ?? "Board");
      }
      return parts.join(" › ");
    },
  };
}

export function iconForSourceType(sourceType: SearchSourceType): IconName {
  if (sourceType === "board") return "board";
  if (sourceType === "comment") return "comment";
  return "list";
}

export function fallbackTitle(sourceType: SearchSourceType) {
  if (sourceType === "board") return "Board";
  if (sourceType === "comment") return "Comment";
  return "Task";
}

export function findCurrentBoardTaskIdMatch(query: string, tasks: Task[]) {
  const normalizedQuery = query.trim().toLowerCase();
  if (normalizedQuery.length < TASK_ID_SEARCH_MIN_LENGTH) {
    return null;
  }
  return tasks.find((task) => task.id.toLowerCase() === normalizedQuery) ?? null;
}

export type SidebarSearchScope = {
  // The project the sidebar search is scoped to, when the route names a known one.
  project: { id: string; name: string } | null;
  // The project filter actually sent to the search API.
  projectId: string | null;
  mode: "none" | "project" | "all" | "task-id";
};

export function resolveSidebarSearchScope({
  allProjects,
  projectTree,
  query,
  scopeProjectId,
}: {
  allProjects: boolean;
  projectTree: ProjectTreeItem[];
  query: string;
  scopeProjectId: string | null;
}): SidebarSearchScope {
  const project = scopeProjectId
    ? projectTree.find((item) => item.project.id === scopeProjectId)?.project ?? null
    : null;
  if (!project) {
    return { project: null, projectId: null, mode: "none" };
  }
  const scopedProject = { id: project.id, name: project.name };
  if (allProjects) {
    return { project: scopedProject, projectId: null, mode: "all" };
  }
  // A pasted task ID should open its task whichever project it belongs to.
  if (looksLikeTaskIdQuery(query)) {
    return { project: scopedProject, projectId: null, mode: "task-id" };
  }
  return { project: scopedProject, projectId: project.id, mode: "project" };
}

export function buildSidebarSearchFilters({
  activeBoardId,
  projectId,
}: {
  activeBoardId: string | null;
  projectId: string | null;
}): SearchFilters {
  return {
    limit: SIDEBAR_RESULT_LIMIT,
    ...(projectId ? { projectId } : {}),
    ...(activeBoardId ? { preferredBoardId: activeBoardId } : {}),
  };
}

// A full task ID in either shape, a trailing part of a humanized one
// (`to-90rvs4`), or a bare suffix. The API matches IDs case-insensitively, so
// typed upper case still counts.
export function looksLikeTaskIdQuery(query: string) {
  const trimmed = query.trim();
  return looksLikeTaskId(trimmed.toLowerCase()) || TASK_ID_SUFFIX_PATTERN.test(trimmed);
}

export function shouldRunSidebarSearchApi({
  currentBoardTasks,
  open,
  query,
}: {
  currentBoardTasks: Task[];
  open: boolean;
  query: string;
}) {
  return open && !findCurrentBoardTaskIdMatch(query, currentBoardTasks);
}

export function taskToSearchResult(
  task: Task,
  matchType: "exact" | "partial",
): SearchResult {
  return {
    searchDocumentId: `task-id:${task.id}`,
    sourceType: "task",
    sourceId: task.id,
    projectId: task.projectId,
    boardId: task.boardId,
    taskId: task.id,
    title: task.title,
    snippet: `Task ID: ${task.id}`,
    distance: matchType === "exact" ? 0 : 0.001,
    metadata: { sourceTextField: "taskId", matchType },
  };
}
