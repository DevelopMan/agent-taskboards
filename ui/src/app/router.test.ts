import { describe, expect, it } from "vitest";
import { parseRoute, routePath } from "./router";

describe("router", () => {
  it("parses and serializes activity routes with repeated project filters", () => {
    expect(
      parseRoute("/activity", "?projectId=project-a&projectId=project-b&sort=asc"),
    ).toEqual({
      view: "activity",
      projectIds: ["project-a", "project-b"],
      sort: "asc",
    });

    expect(
      routePath({
        view: "activity",
        projectIds: ["project-a", "project-b"],
        sort: "asc",
      }),
    ).toBe("/activity?projectId=project-a&projectId=project-b&sort=asc");
  });

  it("defaults activity routes to all projects and newest first", () => {
    expect(parseRoute("/activity", "")).toEqual({
      view: "activity",
      projectIds: [],
      sort: "desc",
    });

    expect(routePath({ view: "activity", projectIds: [], sort: "desc" })).toBe(
      "/activity",
    );
  });

  it("parses and serializes the prompts route", () => {
    expect(parseRoute("/prompts", "")).toEqual({ view: "prompts" });
    expect(routePath({ view: "prompts" })).toBe("/prompts");
  });

  it("parses and serializes search routes with tag filters", () => {
    expect(parseRoute("/search", "?q=%20sqlite%20&tag=api&tag=%20ui%20&tag=api&tag=a%2Cb&match=any")).toEqual({
      view: "search",
      query: "sqlite",
      tags: ["api", "ui", "a,b"],
      tagMatch: "any",
    });
    expect(parseRoute("/search", "?match=bogus")).toEqual({
      view: "search",
      query: null,
      tags: [],
      tagMatch: "all",
    });

    expect(
      routePath({ view: "search", query: "sqlite", tags: ["api", "a,b"], tagMatch: "any" }),
    ).toBe("/search?q=sqlite&tag=api&tag=a%2Cb&match=any");
    expect(routePath({ view: "search", query: null, tags: ["api"], tagMatch: "all" })).toBe(
      "/search?tag=api",
    );
    expect(routePath({ view: "search", query: null, tags: [], tagMatch: "any" })).toBe("/search");
  });
});
