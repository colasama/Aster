import { evaluateLayerTransform } from "../animation/expressions";
import { evaluateUnclampedSourceTime } from "../animation/layer-time";
import type { Composition, EvaluatedTransform, Id, Layer, Project } from "../types";
import { composeClonerTransform, evaluateCloner, MAX_CLONER_INSTANCES } from "./cloner";
import { precompositionNeedsSurface } from "./precomposition-mode";
import {
  IDENTITY_MATRIX,
  type Matrix4,
  multiplyMatrices,
  transformMatrix,
} from "./transform-matrix";

export interface FlattenedSceneLayer {
  layer: Layer;
  sourceComposition: Composition;
  transform: EvaluatedTransform;
  worldMatrix?: Matrix4;
  localTime: number;
  instanceId: string;
  resourceInstanceId: string;
  selectionId: Id;
  /**
   * A normal precomposition stays isolated instead of being flattened into its
   * parent. The renderer evaluates this source at `time` into a GPU texture and
   * maps that texture onto the wrapper quad.
   */
  precompositionSurface?: {
    composition: Composition;
    time: number;
    compositionPath: Id[];
    renderComposition?: Composition;
    sceneLayers?: FlattenedSceneLayer[];
    cameraTime?: number;
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
  parentMatrix: Matrix4 = IDENTITY_MATRIX,
  renderComposition: Composition = composition,
  renderTime: number = time,
  parentThreeDimensional = false,
): FlattenedSceneLayer[] {
  if (compositionStack.has(composition.id)) return [];
  const nextStack = new Set(compositionStack).add(composition.id);
  const output: FlattenedSceneLayer[] = [];
  for (const layer of visibleLayersAtTime(composition, time)) {
    if (compositionStack.size > 0 && layer.kind === "camera") continue;
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
      const worldMatrix = multiplyMatrices(
        parentMatrix,
        evaluateWorldMatrix(layer, composition, time, clone ? clonedTransform : undefined),
      );
      const transform = parentTransform
        ? mapNestedTransform(clonedTransform, parentTransform, composition)
        : clonedTransform;
      const baseInstanceId = `${instancePrefix}/${layer.id}`;
      const resourceInstanceId = `${resourcePrefix}/${layer.id}`;
      const instanceId = clone ? `${baseInstanceId}:clone-${clone.index}` : baseInstanceId;
      if (nested) {
        const nestedTime = evaluateUnclampedSourceTime(layer, time);
        if (nestedTime < 0 || nestedTime >= nested.duration || transform.opacity <= 0) continue;
        if (precompositionNeedsSurface(layer, nested, nestedTime)) {
          const collapsed = layer.collapseTransformations === true;
          const content = collapsed
            ? flattenComposition(
                nested,
                project,
                nestedTime,
                { ...applyWrapperSize(transform, layer, nested), opacity: 1 },
                instanceId,
                resourceInstanceId,
                rootSelectionId,
                nextStack,
                multiplyMatrices(worldMatrix, [
                  layer.size[0] / nested.width,
                  0,
                  0,
                  0,
                  0,
                  layer.size[1] / nested.height,
                  0,
                  0,
                  0,
                  0,
                  1,
                  0,
                  0,
                  0,
                  0,
                  1,
                ]),
                renderComposition,
                renderTime,
                parentThreeDimensional || Boolean(layer.threeDimensional),
              )
            : undefined;
          output.push({
            layer: collapsed
              ? { ...layer, threeDimensional: false }
              : parentThreeDimensional
                ? { ...layer, threeDimensional: true }
                : layer,
            sourceComposition: composition,
            transform: collapsed
              ? {
                  position: [renderComposition.width / 2, renderComposition.height / 2, 0],
                  anchor: [renderComposition.width / 2, renderComposition.height / 2, 0],
                  scale: [100, 100, 100],
                  rotation: [0, 0, 0],
                  opacity: transform.opacity,
                }
              : transform,
            worldMatrix:
              collapsed || (!layer.parentId && !parentTransform) ? undefined : worldMatrix,
            localTime: time,
            instanceId,
            resourceInstanceId,
            selectionId: rootSelectionId,
            precompositionSurface: {
              composition: nested,
              time: nestedTime,
              compositionPath: [...nextStack],
              renderComposition: collapsed ? renderComposition : undefined,
              sceneLayers: content,
              cameraTime: collapsed ? renderTime : undefined,
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
          multiplyMatrices(worldMatrix, [
            layer.size[0] / nested.width,
            0,
            0,
            0,
            0,
            layer.size[1] / nested.height,
            0,
            0,
            0,
            0,
            1,
            0,
            0,
            0,
            0,
            1,
          ]),
          renderComposition,
          renderTime,
          parentThreeDimensional || Boolean(layer.threeDimensional),
        );
        for (const nestedLayer of nestedLayers) {
          if (output.length >= MAX_CLONER_INSTANCES) break;
          output.push(nestedLayer);
        }
        continue;
      }
      output.push({
        layer: parentThreeDimensional ? { ...layer, threeDimensional: true } : layer,
        sourceComposition: composition,
        transform,
        worldMatrix: layer.parentId || parentTransform ? worldMatrix : undefined,
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

export function evaluateWorldMatrix(
  layer: Layer,
  composition: Composition,
  time: number,
  override?: EvaluatedTransform,
  visited = new Set<Id>(),
): Matrix4 {
  const local = transformMatrix(override ?? evaluateLayerTransform(layer, time));
  if (override || !layer.parentId || visited.has(layer.id)) return local;
  const parent = composition.layers.find((candidate) => candidate.id === layer.parentId);
  if (!parent) return local;
  visited.add(layer.id);
  return multiplyMatrices(
    evaluateWorldMatrix(parent, composition, time, undefined, visited),
    local,
  );
}
