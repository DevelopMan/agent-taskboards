import { useEffect, useMemo, useRef, useState } from "react";
import { Topbar } from "../../components/layout";
import {
  EmptyState,
  Icon,
  InlineError,
  Mono,
  SkeletonRows,
} from "../../components/ui";
import { TagFilter } from "../../components/ui/TagFilter";
import {
  fallbackTitle,
  iconForSourceType,
} from "../../components/layout/SidebarSearch";
import type {
  LabelCount,
  LabelMatchMode,
  ProjectTreeItem,
  SearchResult,
  SearchSourceType,
} from "../../domain/types";
import { api } from "../../lib/api";
import { useSearch, type SearchFilters } from "./useSearch";

const ALL_SOURCE_TYPES: SearchSourceType[] = ["board", "task", "comment"];
const WORKSPACE_RESULT_LIMIT = 25;
const URL_DEBOUNCE_MS = 350;

export interface SearchWorkspaceState {
  query: string | null;
  tags: string[];
  tagMatch: LabelMatchMode;
}

export function SearchWorkspace({
  initialQuery,
  initialTagMatch,
  initialTags,
  onOpenResult,
  onSearchChange,
  preferredBoardId,
  projectTree,
}: {
  initialQuery: string | null;
  initialTagMatch: LabelMatchMode;
  initialTags: string[];
  onOpenResult: (result: SearchResult) => void;
  onSearchChange: (state: SearchWorkspaceState) => void;
  preferredBoardId: string | null;
  projectTree: ProjectTreeItem[];
}) {
  const [query, setQuery] = useState(initialQuery ?? "");
  const [tags, setTags] = useState(initialTags);
  const [tagMatch, setTagMatch] = useState(initialTagMatch);
  const [availableTags, setAvailableTags] = useState<LabelCount[]>([]);
  const [projectId, setProjectId] = useState<string>("");
  const [enabledSources, setEnabledSources] = useState<Set<SearchSourceType>>(
    () => new Set(ALL_SOURCE_TYPES),
  );
  const [includeArchived, setIncludeArchived] = useState(false);
  const lastInitialQueryRef = useRef(initialQuery ?? "");
  const lastInitialTagsRef = useRef(tagStateKey(initialTags, initialTagMatch));

  useEffect(() => {
    const next = initialQuery ?? "";
    if (next !== lastInitialQueryRef.current) {
      lastInitialQueryRef.current = next;
      setQuery(next);
    }
  }, [initialQuery]);

  useEffect(() => {
    const next = tagStateKey(initialTags, initialTagMatch);
    if (next !== lastInitialTagsRef.current) {
      lastInitialTagsRef.current = next;
      setTags(initialTags);
      setTagMatch(initialTagMatch);
    }
  }, [initialTagMatch, initialTags]);

  useEffect(() => {
    let cancelled = false;
    api
      .listLabels({
        ...(projectId ? { projectId } : {}),
        ...(includeArchived ? { includeArchived: true } : {}),
      })
      .then((labels) => {
        if (!cancelled) setAvailableTags(labels);
      })
      .catch(() => {
        // The picker is a convenience; selected tags and search still work
        // without the list, and search surfaces its own errors.
        if (!cancelled) setAvailableTags([]);
      });
    return () => {
      cancelled = true;
    };
  }, [includeArchived, projectId]);

  const filters = useMemo<SearchFilters>(() => {
    const sourceTypes =
      enabledSources.size === ALL_SOURCE_TYPES.length
        ? undefined
        : ALL_SOURCE_TYPES.filter((type) => enabledSources.has(type));
    return {
      limit: WORKSPACE_RESULT_LIMIT,
      ...(projectId ? { projectId } : {}),
      ...(preferredBoardId ? { preferredBoardId } : {}),
      ...(sourceTypes ? { sourceTypes } : {}),
      ...(includeArchived ? { includeArchived: true } : {}),
      ...(tags.length > 0 ? { labels: tags, labelMatch: tagMatch } : {}),
    };
  }, [enabledSources, includeArchived, preferredBoardId, projectId, tagMatch, tags]);

  const { results, loading, error, lastQuery } = useSearch({ query, filters });

  useEffect(() => {
    const trimmed = query.trim();
    const handle = window.setTimeout(() => {
      onSearchChange({ query: trimmed ? trimmed : null, tags, tagMatch });
    }, URL_DEBOUNCE_MS);
    return () => window.clearTimeout(handle);
  }, [query, onSearchChange, tagMatch, tags]);

  const crumbLookup = useMemo(() => {
    const projectNames = new Map<string, string>();
    const boardNames = new Map<string, string>();
    for (const item of projectTree) {
      projectNames.set(item.project.id, item.project.name);
      for (const board of item.boards) {
        boardNames.set(board.id, board.name);
      }
    }
    return (result: Pick<SearchResult, "projectId" | "boardId">) => {
      const parts: string[] = [];
      if (result.projectId) parts.push(projectNames.get(result.projectId) ?? "Project");
      if (result.boardId) parts.push(boardNames.get(result.boardId) ?? "Board");
      return parts.join(" › ");
    };
  }, [projectTree]);

  const trimmed = query.trim();
  const hasQuery = trimmed.length > 0 || tags.length > 0;
  const showSkeleton = loading && results.length === 0;

  return (
    <>
      <Topbar crumbs={[{ label: "Search", icon: <Icon name="search" /> }]} />
      <div className="workspace-pane">
        <div className="search-pane">
          <div className="search-pane__header">
            <div className="search-pane__input">
              <Icon name="search" size={16} />
              <input
                aria-label="Search"
                autoFocus
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search tasks, boards, and comments..."
                spellCheck={false}
                type="search"
                value={query}
              />
            </div>
            <div className="search-pane__filters">
              <label className="search-filter">
                <span>Project</span>
                <select
                  onChange={(event) => setProjectId(event.target.value)}
                  value={projectId}
                >
                  <option value="">All projects</option>
                  {projectTree.map((item) => (
                    <option key={item.project.id} value={item.project.id}>
                      {item.project.name}
                    </option>
                  ))}
                </select>
              </label>
              <div className="search-filter search-filter--chips">
                <span>Type</span>
                <div className="search-chip-group">
                  {ALL_SOURCE_TYPES.map((type) => {
                    const active = enabledSources.has(type);
                    return (
                      <button
                        aria-pressed={active}
                        className={
                          active ? "search-chip search-chip--active" : "search-chip"
                        }
                        key={type}
                        onClick={() =>
                          setEnabledSources((current) => {
                            const next = new Set(current);
                            if (next.has(type)) {
                              if (next.size === 1) {
                                return current;
                              }
                              next.delete(type);
                            } else {
                              next.add(type);
                            }
                            return next;
                          })
                        }
                        type="button"
                      >
                        <Icon name={iconForSourceType(type)} />
                        <span>{labelForSourceType(type)}</span>
                      </button>
                    );
                  })}
                </div>
              </div>
              <div className="search-filter search-filter--tags">
                <span>Tags</span>
                <TagFilter
                  labels={availableTags}
                  match={tagMatch}
                  onChange={(nextTags, nextMatch) => {
                    setTags(nextTags);
                    setTagMatch(nextMatch);
                  }}
                  selected={tags}
                />
              </div>
              <label className="search-filter search-filter--toggle">
                <input
                  checked={includeArchived}
                  onChange={(event) => setIncludeArchived(event.target.checked)}
                  type="checkbox"
                />
                <span>Include archived</span>
              </label>
            </div>
          </div>

          <InlineError message={error} />

          {!hasQuery && (
            <EmptyState
              title="Search your work"
              body="Type a phrase, task ID, label, or natural-language question, or pick tags to list tagged tasks. Results combine text and embedding matches across boards, tasks, and comments."
            />
          )}

          {hasQuery && showSkeleton && <SkeletonRows />}

          {hasQuery && !loading && !error && results.length === 0 && lastQuery !== null && (
            <EmptyState
              title={lastQuery ? `No results for "${lastQuery}"` : "No tasks with these tags"}
              body={
                tags.length > 0
                  ? "Try different words, remove a tag, match any tag, or include archived content."
                  : "Try different words, broaden the source-type filter, or include archived content."
              }
            />
          )}

          {results.length > 0 && (
            <ul className="search-results">
              {results.map((result) => (
                <li key={result.searchDocumentId}>
                  <button
                    className="search-result"
                    onClick={() => onOpenResult(result)}
                    type="button"
                  >
                    <span className={`search-result__badge search-result__badge--${result.sourceType}`}>
                      <Icon name={iconForSourceType(result.sourceType)} />
                      <span>{labelForSourceType(result.sourceType)}</span>
                    </span>
                    <div className="search-result__body">
                      <div className="search-result__title">
                        {result.title ?? fallbackTitle(result.sourceType)}
                      </div>
                      <div className="search-result__crumb">
                        <Mono faded>{crumbLookup(result) || "—"}</Mono>
                      </div>
                      <div className="search-result__snippet">{result.snippet}</div>
                    </div>
                    {!isTagListing(result) && <Mono faded>{formatDistance(result.distance)}</Mono>}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </>
  );
}

function labelForSourceType(sourceType: SearchSourceType) {
  if (sourceType === "board") return "Board";
  if (sourceType === "comment") return "Comment";
  return "Task";
}

function tagStateKey(tags: string[], tagMatch: LabelMatchMode) {
  return JSON.stringify([tags, tagMatch]);
}

// Tag-only results are a plain listing, so a relevance distance means nothing.
function isTagListing(result: SearchResult) {
  return (
    typeof result.metadata === "object" &&
    result.metadata !== null &&
    (result.metadata as { matchType?: unknown }).matchType === "labels"
  );
}

function formatDistance(distance: number) {
  if (!Number.isFinite(distance)) {
    return "—";
  }
  return distance.toFixed(3);
}
