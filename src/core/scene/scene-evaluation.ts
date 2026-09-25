import { evaluateLayerTransform } from "../animation/expressions";
import { evaluateLayerSourceTime } from "../animation/layer-time";
import {
  containsCameraLayer,
  NESTED_ADJUSTMENT_ERROR,
  needsPrecompositionSurface,
} from "../project/project-render-boundaries";
import type { Composition, EvaluatedTransform, Id, Layer, Project } from "../types";
import { composeClonerTransform, evaluateCloner, MAX_CLONER_INSTANCES } from "./cloner";

type TransformEvaluator = (layer: Layer) => EvaluatedTransform;
type CompositionEvaluations = Map<Composition, Map<number, TransformEvaluator>>;

export interface FlattenedSceneLayer {
  layer: Layer;
  sourceComposition: Composition;
  transform: EvaluatedTransform;
  localTime: number;
  instanceId: string;
  resourceInstanceId: string;
  selectionId: Id;
  /**
   * A 3D precomposition or a 2D group with effects stays isolated instead of being flattened into its
   * parent. The renderer evaluates this source at `time` into a GPU texture and
   * maps that texture onto the wrapper quad.
   */
  precompositionSurface?: {
    composition: Composition;
    time: number;
    compositionPath: Id[];
  };
}

export function visibleLayersAtTime(composition: Composition, time: number): Layer[] {
  const timed = composition.layers.filter((layer) => isLayerActiveAtTime(layer, time));
  return timed.some((layer) => layer.solo) ? timed.filter((layer) => layer.solo) : timed;
}

/** Layer spans are half-open, so adjacent edits cannot render twice at their shared cut. */
export function isLayerActiveAtTime(layer: Layer, time: number): boolean {
  // Subtracting a shot's start can place an exact frame a few ULPs before its cut.
  // Keep adjacent spans half-open under the same nanosecond tolerance.
  const tolerance = 1e-9;
  return layer.visible && time >= layer.inPoint - tolerance && time < layer.outPoint - tolerance;
}

export function evaluateWorldTransform(
  layer: Layer,
  composition: Composition,
  time: number,
): EvaluatedTransform {
  return evaluateRecursive(layer, composition, time, new Set());
}

export function flattenSceneLayers(
  composition: Composition,
  project: Project | undefined,
  time: number,
): FlattenedSceneLayer[] {
  return flattenComposition(
    composition,
    project,
    time,
    undefined,
    "root",
    "root",
    undefined,
    new Set(),
    new Map(),
  );
}

function flattenComposition(
  composition: Composition,
  project: Project | undefined,
  time: number,
  parentTransform: EvaluatedTransform | undefined,
  instancePrefix: string,
  resourcePrefix: string,
  selectionId: Id | undefined,
  compositionStack: Set<Id>,
  evaluations: CompositionEvaluations,
): FlattenedSceneLayer[] {
  if (compositionStack.has(composition.id)) return [];
  const nextStack = new Set(compositionStack).add(composition.id);
  const output: FlattenedSceneLayer[] = [];
  let times = evaluations.get(composition);
  if (!times) {
    times = new Map();
    evaluations.set(composition, times);
  }
  let evaluate = times.get(time);
  if (!evaluate) {
    evaluate = createTransformEvaluator(composition, time);
    times.set(time, evaluate);
  }
  for (const layer of visibleLayersAtTime(composition, time)) {
    if (layer.kind === "adjustment" && compositionStack.size > 0)
      throw new Error(NESTED_ADJUSTMENT_ERROR);
    const localTransform = evaluate(layer);
    const rootSelectionId = selectionId ?? layer.id;
    const nested =
      layer.kind === "precomposition" && layer.sourceCompositionId
        ? project?.compositions.find((candidate) => candidate.id === layer.sourceCompositionId)
        : undefined;
    // Adjustment layers are composition-wide stack operations, never spatial instances.
    const clones =
      layer.kind !== "adjustment" && layer.cloner
        ? evaluateCloner(layer.cloner, time).instances
        : undefined;
    const cloneInstances = clones ?? [undefined];
    for (const clone of cloneInstances) {
      if (output.length >= MAX_CLONER_INSTANCES) break;
      const clonedTransform = clone
        ? composeClonerTransform(localTransform, clone)
        : localTransform;
      const transform = parentTransform
        ? mapNestedTransform(clonedTransform, parentTransform, composition)
        : clonedTransform;
      const baseInstanceId = `${instancePrefix}/${layer.id}`;
      const resourceInstanceId = `${resourcePrefix}/${layer.id}`;
      const instanceId = clone ? `${baseInstanceId}:clone-${clone.index}` : baseInstanceId;
      if (nested) {
        const nestedTime = evaluateLayerSourceTime(layer, time, nested.duration);
        if (needsPrecompositionSurface(layer) || containsCameraLayer(nested)) {
          output.push({
            layer,
            sourceComposition: composition,
            transform,
            localTime: time,
            instanceId,
            resourceInstanceId,
            selectionId: rootSelectionId,
            precompositionSurface: {
              composition: nested,
              time: nestedTime,
              compositionPath: [...nextStack],
            },
          });
          continue;
        }
        const wrapperTransform = applyWrapperSize(transform, layer, nested);
        const nestedLayers = flattenComposition(
          nested,
          project,
          nestedTime,
          wrapperTransform,
          instanceId,
          resourceInstanceId,
          rootSelectionId,
          nextStack,
          evaluations,
        );
        for (const nestedLayer of nestedLayers) {
          if (output.length >= MAX_CLONER_INSTANCES) break;
          output.push(nestedLayer);
        }
        continue;
      }
      output.push({
        layer,
        sourceComposition: composition,
        transform,
        localTime: time,
        instanceId,
        resourceInstanceId,
        selectionId: rootSelectionId,
      });
    }
  }
  return output;
}

function applyWrapperSize(
  transform: EvaluatedTransform,
  layer: Layer,
  nested: Composition,
): EvaluatedTransform {
  // Flattened children are centered in source space. Move that center by the
  // wrapper's anchor offset before applying its source-to-wrapper size ratio.
  const offsetX = ((layer.size[0] / 2 - transform.anchor[0]) * transform.scale[0]) / 100;
  const offsetY = ((layer.size[1] / 2 - transform.anchor[1]) * transform.scale[1]) / 100;
  const radians = (transform.rotation[2] * Math.PI) / 180;
  return {
    ...transform,
    position: [
      transform.position[0] + offsetX * Math.cos(radians) - offsetY * Math.sin(radians),
      transform.position[1] + offsetX * Math.sin(radians) + offsetY * Math.cos(radians),
      transform.position[2] - (transform.anchor[2] * transform.scale[2]) / 100,
    ],
    scale: [
      transform.scale[0] * (layer.size[0] / nested.width),
      transform.scale[1] * (layer.size[1] / nested.height),
      transform.scale[2],
    ],
  };
}

function mapNestedTransform(
  child: EvaluatedTransform,
  parent: EvaluatedTransform,
  source: Composition,
): EvaluatedTransform {
  const scaleX = parent.scale[0] / 100;
  const scaleY = parent.scale[1] / 100;
  const offsetX = (child.position[0] - source.width / 2) * scaleX;
  const offsetY = (child.position[1] - source.height / 2) * scaleY;
  const radians = (parent.rotation[2] * Math.PI) / 180;
  return {
    position: [
      parent.position[0] + offsetX * Math.cos(radians) - offsetY * Math.sin(radians),
      parent.position[1] + offsetX * Math.sin(radians) + offsetY * Math.cos(radians),
      parent.position[2] + child.position[2] * (parent.scale[2] / 100),
    ],
    rotation: child.rotation.map(
      (value, index) =>
        value * (index === 2 && scaleX * scaleY < 0 ? -1 : 1) + parent.rotation[index],
    ) as [number, number, number],
    scale: child.scale.map((value, index) => (value * parent.scale[index]) / 100) as [
      number,
      number,
      number,
    ],
    anchor: child.anchor,
    opacity: child.opacity * parent.opacity,
  };
}

function evaluateRecursive(
  layer: Layer,
  composition: Composition,
  time: number,
  visited: Set<Id>,
): EvaluatedTransform {
  const local = evaluateLayerTransform(layer, time);
  if (!layer.parentId || visited.has(layer.id)) return local;
  const parent = composition.layers.find((candidate) => candidate.id === layer.parentId);
  if (!parent) return local;
  visited.add(layer.id);
  const world = evaluateRecursive(parent, composition, time, visited);
  return composeParentTransform(local, world);
}

/** Shared parents and repeated precompositions are evaluated once per exact source time. */
function createTransformEvaluator(composition: Composition, time: number): TransformEvaluator {
  const layers = new Map<Id, Layer>();
  for (const layer of composition.layers) if (!layers.has(layer.id)) layers.set(layer.id, layer);
  const resolved = new Map<Layer, EvaluatedTransform>();
  const visiting = new Set<Id>();
  const cycle = Symbol("parent cycle");
  const evaluate: TransformEvaluator = (layer) => {
    const cached = resolved.get(layer);
    if (cached) return cached;
    if (visiting.has(layer.id)) throw cycle;
    visiting.add(layer.id);
    try {
      const local = evaluateLayerTransform(layer, time);
      const parent = layer.parentId ? layers.get(layer.parentId) : undefined;
      const world = parent ? composeParentTransform(local, evaluate(parent)) : local;
      resolved.set(layer, world);
      return world;
    } finally {
      visiting.delete(layer.id);
    }
  };
  return (layer) => {
    try {
      return evaluate(layer);
    } catch (error) {
      if (error !== cycle) throw error;
      // Preserve the existing finite, root-relative behavior for malformed parent cycles.
      return evaluateWorldTransform(layer, composition, time);
    }
  };
}

function composeParentTransform(
  local: EvaluatedTransform,
  world: EvaluatedTransform,
): EvaluatedTransform {
  const scaleX = world.scale[0] / 100;
  const scaleY = world.scale[1] / 100;
  const radians = (world.rotation[2] * Math.PI) / 180;
  const localX = local.position[0] * scaleX;
  const localY = local.position[1] * scaleY;
  return {
    position: [
      world.position[0] + localX * Math.cos(radians) - localY * Math.sin(radians),
      world.position[1] + localX * Math.sin(radians) + localY * Math.cos(radians),
      world.position[2] + local.position[2] * (world.scale[2] / 100),
    ],
    rotation: local.rotation.map(
      (value, index) =>
        value * (index === 2 && scaleX * scaleY < 0 ? -1 : 1) + world.rotation[index],
    ) as [number, number, number],
    scale: local.scale.map((value, index) => (value * world.scale[index]) / 100) as [
      number,
      number,
      number,
    ],
    anchor: local.anchor,
    opacity: local.opacity * world.opacity,
  };
}
