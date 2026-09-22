import { evaluateLayerSourceTime } from "../../core/animation/layer-time";
import type { FlattenedSceneLayer } from "../../core/scene/scene-evaluation";
import type { Composition } from "../../core/types";
import {
  buildSceneGeometry,
  FLOATS_PER_VERTEX,
  type GeometryResult,
  type SceneCamera,
} from "../geometry/geometry";
import type { MediaTextureCache } from "../media/media-texture-cache";
import type { TextMotionBlurPlan } from "./text-motion-blur-plan";
import type { TextRasterBounds } from "./text-raster-bounds";
import { transformedTextRasterScale } from "./text-rasterizer";

export function prepareTextSceneGeometry(
  composition: Composition,
  scenes: FlattenedSceneLayer[],
  geometry: GeometryResult,
  camera: SceneCamera | undefined,
  media: MediaTextureCache,
  resolutionScale: number,
  plans: ReadonlyMap<string, TextMotionBlurPlan>,
): GeometryResult {
  for (const scene of scenes) {
    if (scene.layer.kind !== "text") continue;
    media.prepareText(
      scene.layer,
      scene.resourceInstanceId,
      evaluateLayerSourceTime(scene.layer, scene.localTime),
      composition.frameRate.numerator / composition.frameRate.denominator,
      transformedTextRasterScale(resolutionScale, scene.transform.scale),
      plans.get(scene.resourceInstanceId),
    );
  }
  return expandTextSceneGeometry(composition, scenes, geometry, camera, (id) =>
    media.textBounds(id),
  );
}

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
