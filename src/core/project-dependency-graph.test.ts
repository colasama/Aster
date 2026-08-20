import { describe, expect, it } from "vitest";
import { activeComposition, createDemoProject } from "./project";
import { buildProjectDependencyGraph } from "./project-dependency-graph";

describe("project dependency graph", () => {
  it("models property, effect, layer, and composition dependencies", () => {
    const project = createDemoProject();
    const composition = activeComposition(project);
    const layer = composition.layers.find((candidate) => candidate.effects.length > 1);
    if (!layer) throw new Error("Expected a layer with an effect chain");
    const dependencies = buildProjectDependencyGraph(project);

    expect(dependencies.graph.nodes("composition")).toHaveLength(project.compositions.length);
    expect(dependencies.graph.nodes("layer")).toHaveLength(composition.layers.length);
    expect(dependencies.graph.nodes("property").length).toBe(composition.layers.length * 13);
    expect(dependencies.graph.nodes("effect").length).toBeGreaterThan(0);

    const dirtyProperty = dependencies.propertyNode(layer.id, "opacity");
    const dirtyCount = dependencies.graph.markDirty(dirtyProperty);
    const order = dependencies.graph.consumeDirtyOrder();
    expect(dirtyCount).toBe(3);
    expect(order).toEqual([
      dirtyProperty,
      dependencies.layerNode(layer.id),
      dependencies.compositionNode(composition.id),
    ]);
  });

  it("invalidates an ordered effect chain downstream", () => {
    const project = createDemoProject();
    const composition = activeComposition(project);
    const layer = composition.layers.find((candidate) => candidate.effects.length > 1);
    if (!layer) throw new Error("Expected a layer with an effect chain");
    const dependencies = buildProjectDependencyGraph(project);
    const firstEffect = dependencies.effectNode(layer.effects[0].id);
    dependencies.graph.markDirty(firstEffect);
    const order = dependencies.graph.consumeDirtyOrder();
    expect(order).toEqual([
      firstEffect,
      dependencies.effectNode(layer.effects[1].id),
      dependencies.layerNode(layer.id),
      dependencies.compositionNode(composition.id),
    ]);
  });
});
