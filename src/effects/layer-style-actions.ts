import type { Operation } from "../core/editing/operations";
import type { Layer } from "../core/types";
import { createEffect } from "./registry";

export const LAYER_STYLE_TYPES = ["outer-glow", "drop-shadow", "color-overlay"] as const;
export type LayerStyleType = (typeof LAYER_STYLE_TYPES)[number];

export function canAddLayerStyle(layers: readonly Layer[]): boolean {
  return (
    layers.length > 0 &&
    layers.every(
      (layer) =>
        !layer.locked && !["audio", "null", "camera", "light", "adjustment"].includes(layer.kind),
    )
  );
}

export function addLayerStyleOperations(
  layers: readonly Layer[],
  type: LayerStyleType,
): Operation[] {
  if (!canAddLayerStyle(layers)) return [];
  return layers.map((layer) => {
    const effect = createEffect(type);
    if (type === "color-overlay") effect.parameters.opacity = 100;
    return { type: "addEffect", layerId: layer.id, effect };
  });
}
