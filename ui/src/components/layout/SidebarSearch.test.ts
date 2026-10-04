import { describe, expect, it } from "vitest";
import type { ProjectTreeItem, Task } from "../../domain/types";
import {
  buildSidebarSearchFilters,
  findCurrentBoardTaskIdMatch,
  looksLikeTaskIdQuery,
  resolveSidebarSearchScope,
  shouldRunSidebarSearchApi,
  taskToSearchResult,
} from "./SidebarSearch";

describe("SidebarSearch task ID helpers", () => {
  it("finds exact current-board task ID matches case-insensitively only for long queries", () => {
    const tasks = [
      task({ id: "implement-deterministic-task-id-pp3d7t" }),
      task({ id: "short" }),
    ];

    expect(
      findCurrentBoardTaskIdMatch(
        "IMPLEMENT-DETERMINISTIC-TASK-ID-PP3D7T",
        tasks,
      )?.id,
    ).toBe("implement-deterministic-task-id-pp3d7t");
    expect(findCurrentBoardTaskIdMatch("short", tasks)).toBeNull();
    expect(
      findCurrentBoardTaskIdMatch("deterministic-task-id-pp3d7t", tasks),
    ).toBeNull();
  });

  it("skips the search API when an exact current-board task ID can be opened directly", () => {
    const tasks = [task({ id: "current-board-task-abc123" })];

    expect(
      shouldRunSidebarSearchApi({
        currentBoardTasks: tasks,
        open: true,
        query: "current-board-task-abc123",
      }),
    ).toBe(false);
    expect(
      shouldRunSidebarSearchApi({
        currentBoardTasks: tasks,
        open: true,
        query: "board-task-abc123",
      }),
    ).toBe(true);
    expect(
      shouldRunSidebarSearchApi({
        currentBoardTasks: tasks,
        open: false,
        query: "current-board-task-abc123",
      }),
    ).toBe(false);
  });

  it("builds a task-shaped search result for direct opens", () => {
    const directResult = taskToSearchResult(
      task({ id: "current-board-task-abc123" }),
      "exact",
    );

    expect(directResult).toMatchObject({
      searchDocumentId: "task-id:current-board-task-abc123",
      sourceType: "task",
      sourceId: "current-board-task-abc123",
      taskId: "current-board-task-abc123",
      snippet: "Task ID: current-board-task-abc123",
      distance: 0,
      metadata: { sourceTextField: "taskId", matchType: "exact" },
    });
  });
});

describe("SidebarSearch project scope", () => {
  const projectTree = [projectTreeItem("project-1", "agent-taskboards")];

  it("scopes to the route project when it is a known project", () => {
    expect(
      resolveSidebarSearchScope({
        allProjects: false,
        projectTree,
        query: "sqlite migrations",
        scopeProjectId: "project-1",
      }),
    ).toEqual({
      project: { id: "project-1", name: "agent-taskboards" },
      projectId: "project-1",
      mode: "project",
    });
  });

  it("searches all projects without a known route project", () => {
    const unscoped = { project: null, projectId: null, mode: "none" };

    expect(
      resolveSidebarSearchScope({
        allProjects: false,
        projectTree,
        query: "sqlite",
        scopeProjectId: null,
      }),
    ).toEqual(unscoped);
    expect(
      resolveSidebarSearchScope({
        allProjects: false,
        projectTree,
        query: "sqlite",
        scopeProjectId: "archived-project",
      }),
    ).toEqual(unscoped);
  });

  it("drops the project filter when widened to all projects", () => {
    expect(
      resolveSidebarSearchScope({
        allProjects: true,
        projectTree,
        query: "sqlite",
        scopeProjectId: "project-1",
      }),
    ).toMatchObject({ projectId: null, mode: "all" });
  });

  it("drops the project filter for task-ID-shaped queries", () => {
    expect(
      resolveSidebarSearchScope({
        allProjects: false,
        projectTree,
        query: "scope-sidebar-search-to-90rvs4",
        scopeProjectId: "project-1",
      }),
    ).toMatchObject({ projectId: null, mode: "task-id" });
  });

  it("recognizes task IDs and their trailing parts but not plain words", () => {
    expect(looksLikeTaskIdQuery("scope-sidebar-search-to-90rvs4")).toBe(true);
    expect(looksLikeTaskIdQuery(" SCOPE-SIDEBAR-SEARCH-TO-90RVS4 ")).toBe(true);
    expect(looksLikeTaskIdQuery("to-90rvs4")).toBe(true);
    expect(looksLikeTaskIdQuery("90rvs4")).toBe(true);
    expect(looksLikeTaskIdQuery("V1StGXR8_Z5jdHi6B-myT")).toBe(true);
    expect(looksLikeTaskIdQuery("abcdefghij_klmnopqrst")).toBe(true);

    expect(looksLikeTaskIdQuery("sqlite")).toBe(false);
    expect(looksLikeTaskIdQuery("sqlite migrations")).toBe(false);
    expect(looksLikeTaskIdQuery("search-scope")).toBe(false);
  });

  it("builds search filters with the scoped project and preferred board", () => {
    expect(
      buildSidebarSearchFilters({ activeBoardId: "board-1", projectId: "project-1" }),
    ).toEqual({ limit: 5, projectId: "project-1", preferredBoardId: "board-1" });
    expect(buildSidebarSearchFilters({ activeBoardId: null, projectId: null })).toEqual({
      limit: 5,
    });
  });
});

function projectTreeItem(id: string, name: string): ProjectTreeItem {
  return {
    project: {
      id,
      name,
      description: null,
      repositoryPath: null,
      defaultBranch: null,
      metadata: {},
      archivedAt: null,
      createdAt: null,
      updatedAt: null,
    },
    boards: [],
    taskCount: null,
  };
}

function task(overrides: Partial<Task>): Task {
  return {
    id: "task-abc123",
    projectId: "project-1",
    boardId: "board-1",
    columnId: "column-1",
    title: "Task title",
    description: null,
    position: 0,
    priority: "normal",
    labels: [],
    externalReferences: [],
    metadata: {},
    completedAt: null,
    archivedAt: null,
    createdAt: null,
    updatedAt: null,
    ...overrides,
  };
}
