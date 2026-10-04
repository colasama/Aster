import { evaluateLayerSourceTime } from "../../core/animation/layer-time";
import type { FlattenedSceneLayer } from "../../core/scene/scene-evaluation";
import type { Composition } from "../../core/types";
import type { MediaTextureCache } from "../media/media-texture-cache";
import type { TextMotionBlurPlan } from "./text-motion-blur-plan";
import type { TextRasterBounds } from "./text-raster-bounds";
import { transformedTextRasterScale } from "./text-rasterizer";

/** Finish all shared-instance preparations before snapshotting bounds for geometry consumers. */
export function prepareTextSceneRasters(
  composition: Composition,
  scenes: readonly FlattenedSceneLayer[],
  media: Pick<MediaTextureCache, "prepareText" | "textBounds">,
  resolutionScale: number,
  plans: ReadonlyMap<string, TextMotionBlurPlan>,
): ReadonlyMap<string, TextRasterBounds> {
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
  const bounds = new Map<string, TextRasterBounds>();
  for (const scene of scenes) {
    if (scene.layer.kind !== "text" || bounds.has(scene.resourceInstanceId)) continue;
    const value = media.textBounds(scene.resourceInstanceId);
    if (value) bounds.set(scene.resourceInstanceId, { ...value });
  }
  return bounds;
}
