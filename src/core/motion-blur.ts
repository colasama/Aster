export interface MotionBlurSettings {
  enabled: boolean;
  shutterAngle: number;
  shutterPhase: number;
  samplesPerFrame: number;
  adaptiveSampleLimit: number;
}

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

export type MotionBlurStrategy = "disabled" | "vector" | "accumulation";

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

export function normalizeMotionBlurSettings(
  value: Partial<MotionBlurSettings>,
): MotionBlurSettings {
  return {
    enabled: value.enabled ?? DEFAULT_MOTION_BLUR_SETTINGS.enabled,
    shutterAngle: bounded(value.shutterAngle, 0, 720, DEFAULT_MOTION_BLUR_SETTINGS.shutterAngle),
    shutterPhase: bounded(value.shutterPhase, -720, 720, DEFAULT_MOTION_BLUR_SETTINGS.shutterPhase),
    samplesPerFrame: boundedInteger(
      value.samplesPerFrame,
      2,
      64,
      DEFAULT_MOTION_BLUR_SETTINGS.samplesPerFrame,
    ),
    adaptiveSampleLimit: boundedInteger(
      value.adaptiveSampleLimit,
      2,
      128,
      DEFAULT_MOTION_BLUR_SETTINGS.adaptiveSampleLimit,
    ),
  };
}

/** AE shutter timing: phase locates opening and angle defines exposure length in frame units. */
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
 * Selects a deterministic GPU strategy. Affine/vector-capable layers use one beauty render plus an
 * endpoint vector pass; video, temporal effects, and nonlinear deformation use HDR accumulation.
 */
export function planLayerMotionBlur(
  frameTime: number,
  frameRate: number,
  settings: MotionBlurSettings,
  layer: MotionBlurLayerCapabilities,
  estimatedPixelTravel = 0,
): MotionBlurPlan {
  if (!settings.enabled || !layer.enabled || settings.shutterAngle <= 0) {
    return {
      strategy: "disabled",
      interval: motionBlurInterval(frameTime, frameRate, { ...settings, shutterAngle: 0 }),
    };
  }
  const needsAccumulation =
    layer.hasVideo ||
    layer.hasNonlinearDeformation ||
    layer.hasTemporalEffect ||
    !layer.supportsMotionVectors;
  const adaptiveSamples = adaptiveMotionBlurSampleCount(settings, estimatedPixelTravel);
  const interval = motionBlurInterval(frameTime, frameRate, settings, adaptiveSamples);
  if (needsAccumulation) return { strategy: "accumulation", interval };
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
