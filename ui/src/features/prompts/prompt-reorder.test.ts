import { describe, expect, it } from "vitest";
import {
  applyReorder,
  dropEdge,
  planAdjacentReorder,
  planReorder,
  reorderItems,
  reorderItemsInLibrary,
} from "./prompt-reorder";

const ids = ["a", "b", "c", "d"];

describe("planReorder", () => {
  it("lands on the target's slot when dragging downwards", () => {
    const plan = planReorder({ ids, draggedId: "a", targetId: "c" });

    expect(plan).toEqual({ id: "a", position: 2 });
    expect(applyReorder(ids, "a", plan!.position)).toEqual([
      "b",
      "c",
      "a",
      "d",
    ]);
  });

  it("lands above the target when dragging upwards", () => {
    const plan = planReorder({ ids, draggedId: "d", targetId: "b" });

    expect(plan).toEqual({ id: "d", position: 1 });
    expect(applyReorder(ids, "d", plan!.position)).toEqual([
      "a",
      "d",
      "b",
      "c",
    ]);
  });

  it("swaps neighbours in either direction", () => {
    const down = planReorder({ ids, draggedId: "a", targetId: "b" });
    const up = planReorder({ ids, draggedId: "b", targetId: "a" });

    expect(applyReorder(ids, "a", down!.position)).toEqual([
      "b",
      "a",
      "c",
      "d",
    ]);
    expect(applyReorder(ids, "b", up!.position)).toEqual(["b", "a", "c", "d"]);
  });

  it("returns null for a drop onto the dragged row itself", () => {
    expect(planReorder({ ids, draggedId: "a", targetId: "a" })).toBeNull();
    expect(planReorder({ ids: ["only"], draggedId: "only", targetId: "only" })).toBeNull();
  });

  it("returns null when either id is unknown", () => {
    expect(planReorder({ ids, draggedId: "a", targetId: "z" })).toBeNull();
    expect(planReorder({ ids, draggedId: "z", targetId: "a" })).toBeNull();
  });
});

describe("planAdjacentReorder", () => {
  it("steps over prompts hidden by the current filter", () => {
    const visibleIds = ["a", "c", "d"];

    expect(
      planAdjacentReorder({ ids, visibleIds, id: "c", delta: -1 }),
    ).toEqual({ id: "c", position: 0 });
    expect(
      planAdjacentReorder({ ids, visibleIds, id: "a", delta: 1 }),
    ).toEqual({ id: "a", position: 2 });
  });

  it("moves one row at a time in an unfiltered list", () => {
    const plan = planAdjacentReorder({ ids, visibleIds: ids, id: "c", delta: 1 });

    expect(applyReorder(ids, "c", plan!.position)).toEqual([
      "a",
      "b",
      "d",
      "c",
    ]);
  });

  it("returns null at the ends of the visible list", () => {
    expect(
      planAdjacentReorder({ ids, visibleIds: ids, id: "a", delta: -1 }),
    ).toBeNull();
    expect(
      planAdjacentReorder({ ids, visibleIds: ids, id: "d", delta: 1 }),
    ).toBeNull();
    expect(
      planAdjacentReorder({ ids, visibleIds: ["a", "b"], id: "c", delta: -1 }),
    ).toBeNull();
  });
});

describe("applyReorder", () => {
  it("clamps out-of-range positions", () => {
    expect(applyReorder(ids, "a", 99)).toEqual(["b", "c", "d", "a"]);
    expect(applyReorder(ids, "d", -5)).toEqual(["d", "a", "b", "c"]);
  });
});

describe("reorderItems", () => {
  it("moves the whole row, not just its id", () => {
    const items = [
      { id: "a", name: "A" },
      { id: "b", name: "B" },
      { id: "c", name: "C" },
    ];

    expect(reorderItems(items, "c", 0)).toEqual([
      { id: "c", name: "C" },
      { id: "a", name: "A" },
      { id: "b", name: "B" },
    ]);
  });
});

describe("library-scoped reorders", () => {
  const rows = [
    { id: "d1", libraryId: "default" },
    { id: "c1", libraryId: "custom" },
    { id: "d2", libraryId: "default" },
    { id: "c2", libraryId: "custom" },
    { id: "d3", libraryId: "default" },
  ];
  const defaultIds = rows
    .filter((row) => row.libraryId === "default")
    .map((row) => row.id);

  it("plans against the selected library's ids only", () => {
    const plan = planReorder({ ids: defaultIds, draggedId: "d3", targetId: "d1" });

    expect(plan).toEqual({ id: "d3", position: 0 });
    expect(applyReorder(defaultIds, "d3", plan!.position)).toEqual(["d3", "d1", "d2"]);
  });

  it("refuses a drop involving a row from another library", () => {
    expect(planReorder({ ids: defaultIds, draggedId: "c1", targetId: "d1" })).toBeNull();
    expect(planReorder({ ids: defaultIds, draggedId: "d1", targetId: "c2" })).toBeNull();
    expect(
      planAdjacentReorder({ ids: defaultIds, visibleIds: defaultIds, id: "c1", delta: 1 }),
    ).toBeNull();
  });

  it("mirrors the plan without moving rows of other libraries", () => {
    const next = reorderItemsInLibrary(rows, "d3", 0);

    expect(next.map((row) => row.id)).toEqual(["d3", "c1", "d1", "c2", "d2"]);
    expect(next.filter((row) => row.libraryId === "custom")).toEqual([
      rows[1],
      rows[3],
    ]);
  });

  it("interprets the position inside the moved row's library", () => {
    // Position 1 in the custom library, not index 1 of the full list.
    expect(reorderItemsInLibrary(rows, "c1", 1).map((row) => row.id)).toEqual([
      "d1",
      "c2",
      "d2",
      "c1",
      "d3",
    ]);
  });

  it("leaves the list untouched for an unknown row", () => {
    expect(reorderItemsInLibrary(rows, "zz", 0)).toBe(rows);
  });
});

describe("dropEdge", () => {
  it("points at the side the dragged row will land on", () => {
    expect(dropEdge(ids, "a", "c")).toBe("after");
    expect(dropEdge(ids, "d", "b")).toBe("before");
  });

  it("is absent without a drag, or over the dragged row itself", () => {
    expect(dropEdge(ids, null, "a")).toBeNull();
    expect(dropEdge(ids, "a", "a")).toBeNull();
    expect(dropEdge(ids, "z", "a")).toBeNull();
  });
});
