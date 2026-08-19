import { describe, expect, it } from "vitest";
import { DependencyGraph } from "./dependency-graph";

describe("incremental dependency graph", () => {
  it("invalidates only downstream nodes in topological order", () => {
    const graph = new DependencyGraph();
    graph.addDependency("effect", "source");
    graph.addDependency("composite", "effect");
    graph.addNode("unrelated");
    expect(graph.markDirty("effect")).toBe(2);
    expect(graph.consumeDirtyOrder()).toEqual(["effect", "composite"]);
  });

  it("prevents dependency cycles", () => {
    const graph = new DependencyGraph();
    graph.addDependency("b", "a");
    expect(() => graph.addDependency("a", "b")).toThrow("cycle");
  });
});
