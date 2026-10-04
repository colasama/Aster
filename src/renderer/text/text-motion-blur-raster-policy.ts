import { projectFontRevision } from "../../core/media/project-font-runtime";
import type { Layer } from "../../core/types";
import type { TextMotionBlurPlan, TextMotionBlurSample } from "./text-motion-blur-plan";
import {
  type TextMotionBlurRasterScalePlan,
  TEXT_MOTION_BLUR_WEIGHT_STRIDE as WEIGHT_UNIFORM_STRIDE,
} from "./text-motion-blur-raster-input";
import { textRasterResolutionScale, textRasterSize } from "./text-rasterizer";

export function boundTextMotionBlurSamples(
  samples: readonly TextMotionBlurSample[],
  pixelBytes: number,
  byteBudget: number,
): TextMotionBlurSample[] {
  if (samples.length === 0) return [];
  const bytes = Math.max(4, Math.floor(pixelBytes));
  const budget = Math.max(0, Math.floor(byteBudget));
  // One linear RGBA16F accumulation, sample RGBA8 textures, and aligned uniform weights consume
  // transient space. The resolved RGBA8 output is governed by the separate resident budget.
  const fixedBytes = bytes * 2;
  const maximumSamples = Math.min(
    samples.length,
    Math.max(0, Math.floor((budget - fixedBytes) / (bytes + WEIGHT_UNIFORM_STRIDE))),
  );
  if (maximumSamples <= 0) return [];
  if (maximumSamples >= samples.length) return samples.map((sample) => ({ ...sample }));
  const selectedIndices = Array.from({ length: maximumSamples }, (_, index) =>
    maximumSamples === 1
      ? Math.floor((samples.length - 1) / 2)
      : Math.round((index * (samples.length - 1)) / (maximumSamples - 1)),
  );
  const selected = selectedIndices.map((index) => ({ ...samples[index], weight: 0 }));
  for (let index = 0; index < samples.length; index += 1) {
    let nearest = 0;
    for (let candidate = 1; candidate < selectedIndices.length; candidate += 1)
      if (Math.abs(selectedIndices[candidate] - index) < Math.abs(selectedIndices[nearest] - index))
        nearest = candidate;
    selected[nearest].weight += samples[index].weight;
  }
  return selected;
}

export function planTextMotionBlurRasterScale(
  layer: Pick<Layer, "size">,
  maximumDimension: number,
  requestedResolutionScale: number,
  canonicalSampleCount: number,
  transientBudget: number,
  residentBudget: number,
): TextMotionBlurRasterScalePlan {
  const requestedScale = textRasterResolutionScale(requestedResolutionScale);
  const minimumSampleCount = canonicalSampleCount > 1 ? 2 : Math.max(0, canonicalSampleCount);
  const scales = discreteTextRasterScales(requestedScale);
  for (let index = scales.length - 1; index >= 0; index -= 1) {
    const resolutionScale = scales[index];
    const { width, height } = textRasterSize(layer, maximumDimension, resolutionScale);
    const pixelBytes = width * height * 4;
    const requiredTransientBytes =
      pixelBytes * 2 + minimumSampleCount * (pixelBytes + WEIGHT_UNIFORM_STRIDE);
    if (pixelBytes > residentBudget || requiredTransientBytes > transientBudget) continue;
    return {
      requestedScale,
      resolutionScale,
      width,
      height,
      pixelBytes,
      minimumSampleCount,
      requiredTransientBytes,
      reduced: resolutionScale < requestedScale,
    };
  }
  const { width, height } = textRasterSize(layer, maximumDimension, 1);
  const pixelBytes = width * height * 4;
  const requiredTransientBytes =
    pixelBytes * 2 + minimumSampleCount * (pixelBytes + WEIGHT_UNIFORM_STRIDE);
  if (pixelBytes > residentBudget)
    throw new Error(
      `Temporal text motion blur ${width}×${height} requires ${pixelBytes} resident bytes; budget is ${Math.max(0, Math.floor(residentBudget))}`,
    );
  throw new Error(
    `Temporal text motion blur ${width}×${height} requires ${requiredTransientBytes} transient bytes for ${minimumSampleCount} samples at 1x; budget is ${Math.max(0, Math.floor(transientBudget))}`,
  );
}

export function textMotionBlurRasterSource(
  layer: Layer,
  plan: TextMotionBlurPlan,
  samples: readonly TextMotionBlurSample[],
  resolutionScale: number,
): string {
  return JSON.stringify([
    "text-motion-blur-v1",
    layer.text,
    layer.name,
    layer.color,
    layer.size,
    layer.textStyle,
    projectFontRevision(),
    layer.textAnimator,
    samples.map((sample) => [sample.timeBucket, sample.weight]),
    plan.transparentWeight,
    resolutionScale,
  ]);
}

function discreteTextRasterScales(maximum: number): number[] {
  const result = [1];
  while (result[result.length - 1] < maximum) {
    const next = Math.min(maximum, result[result.length - 1] * 1.25);
    if (next <= result[result.length - 1]) break;
    result.push(next);
  }
  return result;
}
