import type { MotionBlurSettings } from "../../core/types";

export const MOTION_BLUR_UNIFORM_BYTES = 32;
export interface MotionBlurFrameSettings extends MotionBlurSettings {
  /** Frame-time position within the shutter interval: 0=open, 1=close. */
  framePosition: number;
  maximumRadius: number;
}
export function boundedMotionDimension(value: number): number {
  return Math.min(16_384, Math.max(1, Math.floor(Number.isFinite(value) ? value : 1)));
}
/** Preserve the production shader's mixed float/u32 layout in explicit little-endian bytes. */
export function buildMotionBlurUniforms(
  width: number,
  height: number,
  settings: MotionBlurFrameSettings,
): ArrayBuffer {
  const buffer = new ArrayBuffer(MOTION_BLUR_UNIFORM_BYTES);
  const view = new DataView(buffer);
  view.setFloat32(0, boundedMotionDimension(width), true);
  view.setFloat32(4, boundedMotionDimension(height), true);
  const samples = Math.round(bounded(settings.samplesPerFrame, 2, 64, 8));
  view.setUint32(8, samples, true);
  view.setUint32(
    12,
    Math.max(samples, Math.round(bounded(settings.adaptiveSampleLimit, 2, 128, 32))),
    true,
  );
  view.setFloat32(16, bounded(settings.maximumRadius, 0, 256, 128), true);
  view.setFloat32(20, bounded(settings.framePosition, -4, 4, 0.5), true);
  return buffer;
}
function bounded(value: number, minimum: number, maximum: number, fallback: number): number {
  return Math.min(maximum, Math.max(minimum, Number.isFinite(value) ? value : fallback));
}
