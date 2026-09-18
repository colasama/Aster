import type { Composition, Layer } from "../types";

/** Effects and adjustment operations establish a compositing boundary even when collapsed. */
export function precompositionNeedsSurface(
  layer: Layer,
  source: Composition,
  time: number,
): boolean {
  const active = source.layers.filter(
    (child) => child.visible && time >= child.inPoint && time < child.outPoint,
  );
  const solo = active.some((child) => child.solo);
  return (
    !layer.collapseTransformations ||
    layer.blendMode !== "normal" ||
    layer.effects.some((effect) => effect.enabled) ||
    active.some((child) => child.kind === "adjustment" && (!solo || child.solo))
  );
}
