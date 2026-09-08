import { evaluateLayerTransform } from "../animation/expressions";
import { evaluateLayerSourceTime } from "../animation/layer-time";
import { NESTED_ADJUSTMENT_ERROR } from "../project/project-render-boundaries";
import type { Composition, EvaluatedTransform, Id, Layer, Project } from "../types";
import { composeClonerTransform, evaluateCloner, MAX_CLONER_INSTANCES } from "./cloner";

export interface FlattenedSceneLayer {
  layer: Layer;
  sourceComposition: Composition;
  transform: EvaluatedTransform;
  localTime: number;
  instanceId: string;
  resourceInstanceId: string;
  selectionId: Id;
  /**
   * A 3D precomposition stays isolated instead of being flattened into its
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
  return layer.visible && time >= layer.inPoint && time < layer.outPoint;
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
): FlattenedSceneLayer[] {
  if (compositionStack.has(composition.id)) return [];
  const nextStack = new Set(compositionStack).add(composition.id);
  const output: FlattenedSceneLayer[] = [];
  for (const layer of visibleLayersAtTime(composition, time)) {
    if (layer.kind === "adjustment" && compositionStack.size > 0)
      throw new Error(NESTED_ADJUSTMENT_ERROR);
    const localTransform = evaluateWorldTransform(layer, composition, time);
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
        if (layer.threeDimensional) {
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
  return {
    ...transform,
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
    rotation: child.rotation.map((value, index) => value + parent.rotation[index]) as [
      number,
      number,
      number,
    ],
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
    rotation: local.rotation.map((value, index) => value + world.rotation[index]) as [
      number,
      number,
      number,
    ],
    scale: local.scale.map((value, index) => (value * world.scale[index]) / 100) as [
      number,
      number,
      number,
    ],
    anchor: local.anchor,
    opacity: local.opacity * world.opacity,
  };
}
