import type { FlattenedSceneLayer } from "../../core/scene/scene-evaluation";
import type { Composition } from "../../core/types";
import {
  buildSceneGeometry,
  FLOATS_PER_VERTEX,
  type GeometryResult,
  type SceneCamera,
} from "../geometry/geometry";
import type { TextRasterBounds } from "./text-raster-bounds";

/** Replace only text quads; keep cached mesh/vector geometry and scene evaluation untouched. */
export function expandTextSceneGeometry(
  composition: Composition,
  scenes: FlattenedSceneLayer[],
  geometry: GeometryResult,
  camera: SceneCamera | undefined,
  readBounds: (id: string) => TextRasterBounds | undefined,
): GeometryResult {
  let data: Float32Array | undefined;
  for (const scene of scenes) {
    if (scene.layer.kind !== "text" || !readBounds(scene.resourceInstanceId)) continue;
    const batch = geometry.batches.find((candidate) => candidate.instanceId === scene.instanceId);
    if (!batch) continue;
    const text = buildSceneGeometry(composition, [scene], camera, readBounds);
    data ??= geometry.data.slice();
    data.set(text.data, batch.firstVertex * FLOATS_PER_VERTEX);
  }
  return data ? { data, batches: geometry.batches } : geometry;
}
