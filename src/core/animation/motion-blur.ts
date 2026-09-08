import type { Composition, Layer, MotionBlurSettings } from "../types";

export type { MotionBlurSettings } from "../types";

export interface MotionBlurLayerCapabilities {
  enabled: boolean;
  hasVideo: boolean;
  hasNonlinearDeformation: boolean;
  hasTemporalEffect: boolean;
  supportsMotionVectors: boolean;
}

export interface MotionBlurInterval {
  frameTime: number;
  openTime: number;
  closeTime: number;
  duration: number;
  sampleTimes: readonly number[];
}

export type MotionBlurStrategy = "disabled" | "vector";

export interface MotionBlurPlan {
  strategy: MotionBlurStrategy;
  interval: MotionBlurInterval;
  vectorStartTime?: number;
  vectorEndTime?: number;
}

export const DEFAULT_MOTION_BLUR_SETTINGS: MotionBlurSettings = Object.freeze({
  enabled: false,
  shutterAngle: 180,
  shutterPhase: -90,
  samplesPerFrame: 8,
  adaptiveSampleLimit: 32,
});

export function compositionMotionBlurSettings(
  composition: Pick<Composition, "motionBlur">,
): MotionBlurSettings {
  return normalizeMotionBlurSettings(composition.motionBlur ?? DEFAULT_MOTION_BLUR_SETTINGS);
}

export function layerMotionBlurEnabled(layer: Pick<Layer, "motionBlur">): boolean {
  return layer.motionBlur === true;
}

export function layerSupportsMotionBlur(layer: Pick<Layer, "kind">): boolean {
  return !["audio", "null", "camera", "light", "adjustment", "generator"].includes(layer.kind);
}

export function normalizeMotionBlurSettings(
  value: Partial<MotionBlurSettings>,
): MotionBlurSettings {
  const samplesPerFrame = boundedInteger(
    value.samplesPerFrame,
    2,
    64,
    DEFAULT_MOTION_BLUR_SETTINGS.samplesPerFrame,
  );
  return {
    enabled: value.enabled === true,
    shutterAngle: bounded(value.shutterAngle, 0, 720, DEFAULT_MOTION_BLUR_SETTINGS.shutterAngle),
    shutterPhase: bounded(value.shutterPhase, -720, 720, DEFAULT_MOTION_BLUR_SETTINGS.shutterPhase),
    samplesPerFrame,
    adaptiveSampleLimit: Math.max(
      samplesPerFrame,
      boundedInteger(
        value.adaptiveSampleLimit,
        2,
        128,
        DEFAULT_MOTION_BLUR_SETTINGS.adaptiveSampleLimit,
      ),
    ),
  };
}

/** Shutter timing: phase locates opening and angle defines exposure length in frame units. */
export function motionBlurInterval(
  frameTime: number,
  frameRate: number,
  settings: MotionBlurSettings,
  sampleCount = settings.samplesPerFrame,
): MotionBlurInterval {
  const safeTime = Number.isFinite(frameTime) ? frameTime : 0;
  const safeFrameRate = bounded(frameRate, 1, 1_000, 60);
  const frameDuration = 1 / safeFrameRate;
  const duration = (bounded(settings.shutterAngle, 0, 720, 180) / 360) * frameDuration;
  const openTime =
    safeTime + (bounded(settings.shutterPhase, -720, 720, -90) / 360) * frameDuration;
  const closeTime = openTime + duration;
  const count = duration > 0 ? boundedInteger(sampleCount, 2, 128, 8) : 0;
  const sampleTimes = Array.from(
    { length: count },
    (_, index) => openTime + ((index + 0.5) / count) * duration,
  );
  return { frameTime: safeTime, openTime, closeTime, duration, sampleTimes };
}

/**
 * Selects the deterministic endpoint-vector strategy. Unsupported topology is explicitly disabled
 * instead of silently depending on a previously rendered frame.
 */
export function planLayerMotionBlur(
  frameTime: number,
  frameRate: number,
  settings: MotionBlurSettings,
  layer: MotionBlurLayerCapabilities,
  estimatedPixelTravel = 0,
): MotionBlurPlan {
  if (
    !settings.enabled ||
    !layer.enabled ||
    settings.shutterAngle <= 0 ||
    !layer.supportsMotionVectors
  ) {
    return {
      strategy: "disabled",
      interval: motionBlurInterval(frameTime, frameRate, { ...settings, shutterAngle: 0 }),
    };
  }
  const adaptiveSamples = adaptiveMotionBlurSampleCount(settings, estimatedPixelTravel);
  const interval = motionBlurInterval(frameTime, frameRate, settings, adaptiveSamples);
  return {
    strategy: "vector",
    interval,
    vectorStartTime: interval.openTime,
    vectorEndTime: interval.closeTime,
  };
}

export function adaptiveMotionBlurSampleCount(
  settings: MotionBlurSettings,
  estimatedPixelTravel: number,
): number {
  const base = boundedInteger(settings.samplesPerFrame, 2, 64, 8);
  const limit = Math.max(
    base,
    boundedInteger(
      settings.adaptiveSampleLimit,
      2,
      128,
      DEFAULT_MOTION_BLUR_SETTINGS.adaptiveSampleLimit,
    ),
  );
  const travel = bounded(estimatedPixelTravel, 0, 1_000_000, 0);
  return Math.min(limit, Math.max(base, Math.ceil(travel / 8) + 1));
}

export function normalizedShutterDisplacementScale(
  interval: Pick<MotionBlurInterval, "duration">,
  vectorSampleDelta: number,
): number {
  const delta = Math.abs(Number.isFinite(vectorSampleDelta) ? vectorSampleDelta : 0);
  if (delta <= Number.EPSILON || interval.duration <= 0) return 0;
  return Math.min(8, interval.duration / delta);
}

function bounded(
  value: number | undefined,
  minimum: number,
  maximum: number,
  fallback: number,
): number {
  const finite = typeof value === "number" && Number.isFinite(value) ? value : fallback;
  return Math.min(maximum, Math.max(minimum, finite));
}

function boundedInteger(
  value: number | undefined,
  minimum: number,
  maximum: number,
  fallback: number,
): number {
  return Math.round(bounded(value, minimum, maximum, fallback));
}
