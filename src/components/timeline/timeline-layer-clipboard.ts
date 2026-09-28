import { cloneTimelineLayers } from "../../core/editing/clone-layers";
import type { Layer } from "../../core/types";

export function duplicateTimelineLayers(layers: readonly Layer[]): Layer[] {
  return cloneTimelineLayers(layers, true).map((layer) => ({
    ...layer,
    name: `${layer.name} Copy`,
  }));
}

/**
 * Clones clipboard layers so their earliest in-point lands at the playhead, matching
 * After Effects paste-at-current-time. Timing clamps to the composition duration.
 */
export function pasteTimelineLayers(
  layers: readonly Layer[],
  time: number,
  duration: number,
): Layer[] {
  if (!layers.length) return [];
  const origin = Math.min(...layers.map((layer) => layer.inPoint));
  const shift = time - origin;
  const minimumDuration = 1 / 240;
  return duplicateTimelineLayers(layers).map((layer, index) => {
    const source = layers[index];
    if (!source) return layer;
    const length = Math.max(minimumDuration, source.outPoint - source.inPoint);
    const inPoint = Math.max(0, Math.min(duration - minimumDuration, source.inPoint + shift));
    return { ...layer, inPoint, outPoint: Math.min(duration, inPoint + length) };
  });
}

export function splitTimelineLayers(layers: readonly Layer[], time: number): Layer[] {
  return cloneTimelineLayers(layers, false).map((layer, index) => {
    const source = layers[index];
    if (!source) return layer;
    return {
      ...layer,
      inPoint: time,
      outPoint: source.outPoint,
      ...(!source.timeRemap
        ? {
            timeOffset:
              (source.timeOffset ?? 0) +
              (time - source.inPoint) / Math.max(0.01, source.timeStretch ?? 1),
          }
        : {}),
    };
  });
}
