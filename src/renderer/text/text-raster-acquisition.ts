import { clampTextAnimationTime } from "../../core/animation/text-animator";
import { projectFontRevision } from "../../core/media/project-font-runtime";
import type { Layer } from "../../core/types";
import {
  type RasterizedText,
  rasterizeTextLayer,
  textRasterResolutionScale,
  textRasterSignature,
} from "./text-rasterizer";

export interface RetainedTextRaster {
  source: string;
  signature?: string;
  hasPixels: boolean;
}

export type PreparedTextRaster =
  | { kind: "retained"; source: string }
  | { kind: "raster"; source: string; signature: string; raster: RasterizedText };

/** CPU preparation owns evaluation and rasterization; the upload consumer receives no Layer. */
export function acquireTextRaster(
  layer: Layer,
  localTime: number,
  frameRate: number,
  resolutionScale: number,
  maximumDimension: number,
  previous?: RetainedTextRaster,
): PreparedTextRaster {
  const rasterScale = textRasterResolutionScale(resolutionScale);
  const animationTime = clampTextAnimationTime(layer.textAnimator, localTime);
  const sampleRate = Number.isFinite(frameRate) ? Math.max(1, Math.min(240, frameRate)) : 60;
  const sampledAnimationTime =
    animationTime === undefined ? undefined : Math.round(animationTime * sampleRate) / sampleRate;
  const staticSource = JSON.stringify([
    layer.text,
    layer.name,
    layer.color,
    layer.size,
    layer.textStyle,
    projectFontRevision(),
    layer.textAnimator,
    rasterScale,
  ]);
  const source = JSON.stringify([
    layer.text,
    layer.name,
    layer.color,
    layer.size,
    layer.textStyle,
    projectFontRevision(),
    layer.textAnimator,
    sampledAnimationTime,
    rasterScale,
  ]);
  if (previous?.source === source) return { kind: "retained", source };
  // Preserve the evaluated-glyph reuse rule for moving expression/selector sample times.
  const signature = `${staticSource}|${textRasterSignature(layer, sampledAnimationTime ?? 0).toString(36)}`;
  if (previous?.hasPixels && previous.signature === signature) return { kind: "retained", source };
  const raster = rasterizeTextLayer(layer, maximumDimension, sampledAnimationTime, rasterScale);
  return {
    kind: "raster",
    source,
    signature,
    raster: { ...raster, bounds: raster.bounds && { ...raster.bounds } },
  };
}
