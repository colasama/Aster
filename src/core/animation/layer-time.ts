import type { Layer } from "../types";
import { evaluateAnimatable } from "./timeline";

export function evaluateLayerSourceTime(
  layer: Layer,
  compositionTime: number,
  sourceDuration = Number.POSITIVE_INFINITY,
): number {
  const remapped = evaluateUnclampedSourceTime(layer, compositionTime);
  return Math.min(Math.max(0, sourceDuration), Math.max(0, remapped));
}

/** Nested sources are transparent/silent outside their duration, rather than holding frame zero. */
export function evaluateUnclampedSourceTime(layer: Layer, compositionTime: number): number {
  return layer.timeRemap
    ? evaluateAnimatable(layer.timeRemap, compositionTime)
    : (layer.timeOffset ?? 0) +
        Math.max(0, compositionTime - layer.inPoint) / Math.max(0.01, layer.timeStretch ?? 1);
}
