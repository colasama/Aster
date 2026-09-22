import { cloneTimelineLayers } from "../../core/editing/clone-layers";
import type { Layer } from "../../core/types";

export function duplicateTimelineLayers(layers: readonly Layer[]): Layer[] {
  return cloneTimelineLayers(layers, true).map((layer) => ({
    ...layer,
    name: `${layer.name} Copy`,
  }));
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
