import type { Operation, PropertyPath } from "../editing/operations";
import { solidRenderSize } from "../layers/solid-layer";
import { evaluateWorldTransform } from "../scene/scene-evaluation";
import type { Animatable, Composition, Id, Layer } from "../types";

export interface CompositionCropPlan {
  readonly bounds: {
    readonly left: number;
    readonly top: number;
    readonly right: number;
    readonly bottom: number;
  };
  readonly operations: readonly Operation[];
}

/**
 * Crops the composition coordinate frame to selected 2D layer source bounds.
 * Root layer positions are offset for every keyframe so visual geometry and animation stay fixed.
 */
export function planCompositionCrop(
  composition: Composition,
  selectedLayerIds: readonly Id[],
  time: number,
): CompositionCropPlan | undefined {
  const selected = new Set(selectedLayerIds);
  const bounds = composition.layers
    .filter((layer) => selected.has(layer.id) && isCropBoundsLayer(layer))
    .map((layer) => layerBounds(layer, composition, time));
  if (bounds.length === 0) return undefined;
  const normalized = {
    left: Math.floor(Math.min(...bounds.map((entry) => entry.left))),
    top: Math.floor(Math.min(...bounds.map((entry) => entry.top))),
    right: Math.ceil(Math.max(...bounds.map((entry) => entry.right))),
    bottom: Math.ceil(Math.max(...bounds.map((entry) => entry.bottom))),
  };
  const width = clamp(normalized.right - normalized.left, 16, 16_384);
  const height = clamp(normalized.bottom - normalized.top, 16, 16_384);
  const offsetX = -normalized.left;
  const offsetY = -normalized.top;
  const operations: Operation[] = [
    {
      type: "setCompositionSettings",
      compositionId: composition.id,
      name: composition.name,
      width,
      height,
      frameRate: composition.frameRate,
      duration: composition.duration,
    },
  ];
  for (const layer of composition.layers) {
    if (layer.parentId || layer.kind === "adjustment") continue;
    operations.push(...offsetAnimatable(layer, "position.0", layer.transform.position[0], offsetX));
    operations.push(...offsetAnimatable(layer, "position.1", layer.transform.position[1], offsetY));
  }
  return { bounds: normalized, operations };
}

function isCropBoundsLayer(layer: Layer): boolean {
  return (
    !layer.threeDimensional &&
    layer.kind !== "audio" &&
    layer.kind !== "camera" &&
    layer.kind !== "light" &&
    layer.kind !== "adjustment"
  );
}

function layerBounds(layer: Layer, composition: Composition, time: number) {
  const transform = evaluateWorldTransform(layer, composition, time);
  const size = solidRenderSize(layer);
  const radians = (transform.rotation[2] * Math.PI) / 180;
  const cosine = Math.cos(radians);
  const sine = Math.sin(radians);
  const corners = [
    [0, 0],
    [size[0], 0],
    [size[0], size[1]],
    [0, size[1]],
  ].map(([x = 0, y = 0]) => {
    const scaledX = (x - transform.anchor[0]) * (transform.scale[0] / 100);
    const scaledY = (y - transform.anchor[1]) * (transform.scale[1] / 100);
    return [
      transform.position[0] + scaledX * cosine - scaledY * sine,
      transform.position[1] + scaledX * sine + scaledY * cosine,
    ];
  });
  return {
    left: Math.min(...corners.map((point) => point[0] ?? 0)),
    top: Math.min(...corners.map((point) => point[1] ?? 0)),
    right: Math.max(...corners.map((point) => point[0] ?? 0)),
    bottom: Math.max(...corners.map((point) => point[1] ?? 0)),
  };
}

function offsetAnimatable(
  layer: Layer,
  path: PropertyPath,
  property: Animatable,
  delta: number,
): Operation[] {
  if (Math.abs(delta) < 1e-9) return [];
  if (property.mode === "static")
    return [{ type: "setProperty", layerId: layer.id, path, value: property.value + delta }];
  return property.keyframes.map((keyframe) => ({
    type: "addKeyframe",
    layerId: layer.id,
    path,
    keyframe: { ...keyframe, value: keyframe.value + delta },
  }));
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}
