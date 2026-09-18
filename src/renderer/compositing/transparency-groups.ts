import type { GeometryBatch } from "../geometry/geometry";
import type { SceneRenderItem } from "./render-stack";

/** 2D and effect boundaries split depth-sharing groups. Opaque-only geometry keeps its fast path. */
export function transparencyGroups(
  stack: readonly SceneRenderItem[],
): Map<string, GeometryBatch[]> {
  const groups = new Map<string, GeometryBatch[]>();
  let run: GeometryBatch[] = [];
  const flush = () => {
    if (
      (run.length > 1 || run.some((batch) => batch.vertexCount > 6)) &&
      run.some(
        (batch) =>
          batch.layer.kind === "image" ||
          batch.layer.kind === "video" ||
          batch.layer.kind === "text" ||
          batch.layer.kind === "precomposition" ||
          batch.layer.kind === "shape" ||
          batch.layer.color[3] < 1 ||
          (batch.opacity ?? 1) < 1 ||
          batch.layer.transform.opacity.mode !== "static" ||
          batch.layer.transform.opacity.value < 100 ||
          batch.layer.material?.alphaMode === "blend" ||
          batch.layer.mesh?.sourceMaterial?.alphaMode === "blend",
      )
    ) {
      groups.set(run[0].instanceId, run);
    }
    run = [];
  };
  for (const item of stack) {
    if (
      item.kind !== "geometry" ||
      !(item.batch.layer.threeDimensional || item.batch.layer.kind === "mesh") ||
      item.batch.layer.effects.some((effect) => effect.enabled)
    )
      flush();
    else run.push(item.batch);
  }
  flush();
  return groups;
}
