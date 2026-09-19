import type { FlattenedSceneLayer } from "../../core/scene/scene-evaluation";
import type { GeometryBatch } from "../geometry/geometry";

export type SceneRenderItem = (
  | { kind: "geometry"; batch: GeometryBatch; scene: FlattenedSceneLayer }
  | { kind: "adjustment"; scene: FlattenedSceneLayer }
  | { kind: "generator"; scene: FlattenedSceneLayer }
) & { clearDepth?: true };

/**
 * Routes the editor's top-first layer model into a bottom-first GPU render stack.
 * Adjustment and scene-generator entries stay at their exact layer position without
 * manufacturing geometry or auxiliary-buffer identities.
 */
export function planSceneRenderStack(
  sceneLayers: readonly FlattenedSceneLayer[],
  geometryBatches: readonly GeometryBatch[],
): SceneRenderItem[] {
  const geometryByInstance = new Map(
    geometryBatches.map((batch) => [batch.instanceId, batch] as const),
  );
  const stack: SceneRenderItem[] = [];
  for (let index = sceneLayers.length - 1; index >= 0; index -= 1) {
    const scene = sceneLayers[index];
    if (scene.layer.kind === "adjustment") {
      stack.push({ kind: "adjustment", scene });
      continue;
    }
    if (scene.layer.kind === "generator") {
      stack.push({ kind: "generator", scene });
      continue;
    }
    const batch = geometryByInstance.get(scene.instanceId);
    if (batch) stack.push({ kind: "geometry", batch, scene });
  }
  let previousWas3D = false;
  for (const item of stack) {
    const layer = item.kind === "geometry" ? item.batch.layer : item.scene.layer;
    const is3D = layer.threeDimensional || layer.kind === "mesh";
    // A 2D layer separates depth-sharing 3D groups and composites in stack order.
    if (previousWas3D && !is3D) item.clearDepth = true;
    previousWas3D = is3D;
  }
  return stack;
}
