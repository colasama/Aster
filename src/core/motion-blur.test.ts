import { describe, expect, it } from "vitest";
import {
  adaptiveMotionBlurSampleCount,
  DEFAULT_MOTION_BLUR_SETTINGS,
  motionBlurInterval,
  normalizedShutterDisplacementScale,
  normalizeMotionBlurSettings,
  planLayerMotionBlur,
} from "./motion-blur";

const vectorLayer = {
  enabled: true,
  hasVideo: false,
  hasNonlinearDeformation: false,
  hasTemporalEffect: false,
  supportsMotionVectors: true,
};

describe("motion blur", () => {
  it("centers the AE default 180-degree shutter around the frame time", () => {
    const settings = { ...DEFAULT_MOTION_BLUR_SETTINGS, enabled: true };
    const interval = motionBlurInterval(1, 24, settings);
    expect(interval.openTime).toBeCloseTo(1 - 0.25 / 24);
    expect(interval.closeTime).toBeCloseTo(1 + 0.25 / 24);
    expect(interval.duration).toBeCloseTo(0.5 / 24);
    expect(interval.sampleTimes).toHaveLength(8);
    expect(interval.sampleTimes[0]).toBeGreaterThan(interval.openTime);
    expect(interval.sampleTimes[interval.sampleTimes.length - 1]).toBeLessThan(interval.closeTime);
  });

  it("uses time-addressed shutter endpoints rather than render history", () => {
    const settings = { ...DEFAULT_MOTION_BLUR_SETTINGS, enabled: true };
    const first = planLayerMotionBlur(2, 30, settings, vectorLayer);
    const repeated = planLayerMotionBlur(2, 30, settings, vectorLayer);
    expect(first).toEqual(repeated);
    expect(first).toMatchObject({
      strategy: "vector",
      vectorStartTime: first.interval.openTime,
      vectorEndTime: first.interval.closeTime,
    });
  });

  it("uses bounded adaptive endpoint reconstruction for video-layer transforms", () => {
    const settings = normalizeMotionBlurSettings({
      enabled: true,
      samplesPerFrame: 4,
      adaptiveSampleLimit: 12,
    });
    const plan = planLayerMotionBlur(0, 60, settings, { ...vectorLayer, hasVideo: true }, 200);
    expect(plan.strategy).toBe("vector");
    expect(plan.interval.sampleTimes).toHaveLength(12);
    expect(adaptiveMotionBlurSampleCount(settings, 0)).toBe(4);
    expect(adaptiveMotionBlurSampleCount(settings, 32)).toBe(5);
  });

  it("disables topology that cannot supply stable endpoint vectors", () => {
    const settings = { ...DEFAULT_MOTION_BLUR_SETTINGS, enabled: true };
    expect(
      planLayerMotionBlur(0, 60, settings, { ...vectorLayer, supportsMotionVectors: false })
        .strategy,
    ).toBe("disabled");
  });

  it("requires both composition and layer switches", () => {
    expect(planLayerMotionBlur(0, 60, DEFAULT_MOTION_BLUR_SETTINGS, vectorLayer).strategy).toBe(
      "disabled",
    );
    expect(
      planLayerMotionBlur(
        0,
        60,
        { ...DEFAULT_MOTION_BLUR_SETTINGS, enabled: true },
        { ...vectorLayer, enabled: false },
      ).strategy,
    ).toBe("disabled");
  });

  it("normalizes endpoint displacement to the exact shutter duration", () => {
    const interval = motionBlurInterval(0, 24, {
      ...DEFAULT_MOTION_BLUR_SETTINGS,
      enabled: true,
    });
    expect(normalizedShutterDisplacementScale(interval, interval.duration)).toBe(1);
    expect(normalizedShutterDisplacementScale(interval, interval.duration * 2)).toBe(0.5);
    expect(normalizedShutterDisplacementScale(interval, 0)).toBe(0);
  });
});
