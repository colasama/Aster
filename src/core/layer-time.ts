import { evaluateAnimatable } from "./timeline";
import type { Layer } from "./types";

export function evaluateLayerSourceTime(
  layer: Layer,
  compositionTime: number,
  sourceDuration = Number.POSITIVE_INFINITY,
): number {
  const remapped = layer.timeRemap
    ? evaluateAnimatable(layer.timeRemap, compositionTime)
    : (layer.timeOffset ?? 0) +
      Math.max(0, compositionTime - layer.inPoint) / Math.max(0.01, layer.timeStretch ?? 1);
  return Math.min(Math.max(0, sourceDuration), Math.max(0, remapped));
}
