import type { FlattenedSceneLayer } from "../core/scene-evaluation";
import type { GeometryBatch } from "./geometry";

export type SceneRenderItem =
  | { kind: "geometry"; batch: GeometryBatch }
  | { kind: "adjustment"; scene: FlattenedSceneLayer }
  | { kind: "particle"; scene: FlattenedSceneLayer };

/**
 * Routes the editor's top-first layer model into a bottom-first GPU render stack.
 * Adjustment and particle entries stay at their exact layer position without
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
    if (scene.layer.kind === "particle") {
      stack.push({ kind: "particle", scene });
      continue;
    }
    const batch = geometryByInstance.get(scene.instanceId);
    if (batch) stack.push({ kind: "geometry", batch });
  }
  return stack;
}
