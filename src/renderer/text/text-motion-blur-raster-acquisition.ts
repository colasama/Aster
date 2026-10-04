import type { Layer } from "../../core/types";
import type { TextMotionBlurPlan } from "./text-motion-blur-plan";
import type {
  AcquiredTemporalTextRaster,
  TemporalTextRasterPlan,
} from "./text-motion-blur-raster-input";
import {
  boundTextMotionBlurSamples,
  planTextMotionBlurRasterScale,
  textMotionBlurRasterSource,
} from "./text-motion-blur-raster-policy";
import { includeTextBounds, type TextRasterBounds } from "./text-raster-bounds";
import {
  measureTextLayerBounds,
  rasterizeTextLayer,
  textRasterResolutionScale,
} from "./text-rasterizer";

/** CPU planning freezes bounds, generation identity and budget-selected samples before upload. */
export function planTemporalTextRaster(
  layer: Layer,
  plan: TextMotionBlurPlan,
  resolutionScale: number,
  maximumDimension: number,
  transientBytes: number,
  residentBytes: number,
  previous?: { boundsSource: string; bounds: TextRasterBounds },
): TemporalTextRasterPlan {
  const requestedScale = textRasterResolutionScale(resolutionScale);
  const boundsSource = textMotionBlurRasterSource(layer, plan, plan.samples, requestedScale);
  const bounds =
    previous?.boundsSource === boundsSource
      ? { ...previous.bounds }
      : {
          x: 0,
          y: 0,
          width: Math.max(1, layer.size[0]),
          height: Math.max(1, layer.size[1]),
        };
  if (previous?.boundsSource !== boundsSource)
    for (const sample of plan.samples)
      includeTextBounds(bounds, measureTextLayerBounds(layer, sample.localTime));
  const scale = planTextMotionBlurRasterScale(
    { size: [bounds.width, bounds.height] },
    maximumDimension,
    requestedScale,
    plan.samples.length,
    transientBytes,
    residentBytes,
  );
  const samples = boundTextMotionBlurSamples(plan.samples, scale.pixelBytes, transientBytes);
  if (plan.samples.length > 1 && samples.length < 2)
    throw new Error("Temporal text motion blur requires at least two canonical samples");
  if (plan.samples.length === 1 && samples.length === 0)
    throw new Error("Temporal text samples exceed the bounded GPU transient budget");
  if (scale.pixelBytes * 2 > transientBytes)
    throw new Error("Temporal text accumulation exceeds the bounded GPU transient budget");
  const source = JSON.stringify([
    textMotionBlurRasterSource(layer, plan, samples, scale.resolutionScale),
    bounds,
  ]);
  return { sourceId: layer.id, label: layer.name, source, boundsSource, bounds, scale, samples };
}

/** Complete every sample before cache ownership or GPU resources can be changed. */
export function acquireTemporalTextRasters(
  layer: Layer,
  prepared: TemporalTextRasterPlan,
  maximumDimension: number,
  rasterize: typeof rasterizeTextLayer = rasterizeTextLayer,
): AcquiredTemporalTextRaster {
  const rasters = prepared.samples.map((sample) => {
    const raster = rasterize(
      layer,
      maximumDimension,
      sample.localTime,
      prepared.scale.resolutionScale,
      prepared.bounds,
    );
    if (raster.width !== prepared.scale.width || raster.height !== prepared.scale.height)
      throw new Error("Temporal text raster dimensions changed inside one shutter interval");
    return raster;
  });
  return { ...prepared, rasters };
}
