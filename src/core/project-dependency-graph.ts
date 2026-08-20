import { DependencyGraph, type DependencyNodeKind } from "./dependency-graph";
import type { Composition, Id, Layer, Project } from "./types";

const PROPERTY_PATHS = [
  "position.x",
  "position.y",
  "position.z",
  "rotation.x",
  "rotation.y",
  "rotation.z",
  "scale.x",
  "scale.y",
  "scale.z",
  "anchor.x",
  "anchor.y",
  "anchor.z",
  "opacity",
] as const;

export interface ProjectDependencyGraph {
  graph: DependencyGraph;
  compositionNode(compositionId: Id): Id;
  layerNode(layerId: Id): Id;
  effectNode(effectId: Id): Id;
  propertyNode(layerId: Id, path: string): Id;
}

export function buildProjectDependencyGraph(project: Project): ProjectDependencyGraph {
  const graph = new DependencyGraph();
  for (const composition of project.compositions) registerComposition(graph, composition);
  for (const composition of project.compositions) registerCrossCompositionEdges(graph, composition);
  return {
    graph,
    compositionNode,
    layerNode,
    effectNode,
    propertyNode,
  };
}

function registerComposition(graph: DependencyGraph, composition: Composition): void {
  const output = compositionNode(composition.id);
  addNode(graph, output, "composition", composition.id, composition.name);
  for (const layer of composition.layers) {
    registerLayer(graph, layer);
    graph.addDependency(output, layerNode(layer.id));
  }
}

function registerLayer(graph: DependencyGraph, layer: Layer): void {
  const output = layerNode(layer.id);
  addNode(graph, output, "layer", layer.id, layer.name);
  for (const path of PROPERTY_PATHS) {
    const property = propertyNode(layer.id, path);
    addNode(graph, property, "property", layer.id, `${layer.name} · ${path}`);
    graph.addDependency(output, property);
  }
  let previousEffect: Id | undefined;
  for (const effect of layer.effects) {
    const effectOutput = effectNode(effect.id);
    addNode(graph, effectOutput, "effect", effect.id, `${layer.name} · ${effect.name}`);
    if (previousEffect) graph.addDependency(effectOutput, previousEffect);
    previousEffect = effectOutput;
  }
  if (previousEffect) graph.addDependency(output, previousEffect);
}

function registerCrossCompositionEdges(graph: DependencyGraph, composition: Composition): void {
  for (const layer of composition.layers) {
    if (layer.parentId) graph.addDependency(layerNode(layer.id), layerNode(layer.parentId));
    if (layer.kind === "precomposition" && layer.sourceCompositionId)
      graph.addDependency(layerNode(layer.id), compositionNode(layer.sourceCompositionId));
  }
}

function addNode(
  graph: DependencyGraph,
  id: Id,
  kind: DependencyNodeKind,
  ownerId: Id,
  label: string,
): void {
  graph.addNode(id, { kind, ownerId, label });
}

const compositionNode = (id: Id) => `composition:${id}`;
const layerNode = (id: Id) => `layer:${id}`;
const effectNode = (id: Id) => `effect:${id}`;
const propertyNode = (layerId: Id, path: string) => `property:${layerId}:${path}`;
