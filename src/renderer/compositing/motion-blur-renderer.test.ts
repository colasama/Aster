import { describe, expect, it } from "vitest";
import {
  buildMotionBlurUniforms,
  motionBlurShader,
  planMotionBlurTextures,
} from "./motion-blur-renderer";

describe("motion blur renderer", () => {
  it("bounds adaptive reconstruction settings", () => {
    const buffer = buildMotionBlurUniforms(1920, 1080, {
      enabled: true,
      shutterAngle: 180,
      shutterPhase: -90,
      samplesPerFrame: 4,
      adaptiveSampleLimit: 999,
      framePosition: Number.NaN,
      maximumRadius: 999,
    });
    expect([...new Float32Array(buffer, 0, 2)]).toEqual([1920, 1080]);
    expect([...new Uint32Array(buffer, 8, 2)]).toEqual([4, 128]);
    expect([...new Float32Array(buffer, 16, 2)]).toEqual([256, 0.5]);
  });

  it("keeps full-resolution HDR and reduced tile buffers bounded", () => {
    expect(planMotionBlurTextures(1920, 1080)).toEqual({
      width: 1920,
      height: 1080,
      tileWidth: 120,
      tileHeight: 68,
      estimatedBytes: 16_719_360,
    });
    expect(planMotionBlurTextures(Number.NaN, 99_999).height).toBe(16_384);
  });

  it("uses tile/neighbor maxima and object-aware HDR reconstruction", () => {
    expect(motionBlurShader).toContain("tile_max_fragment");
    expect(motionBlurShader).toContain("neighbor_max_fragment");
    expect(motionBlurShader).toContain("moving_foreground");
    expect(motionBlurShader).toContain("return accumulated / max(weight_sum");
    expect(motionBlurShader).not.toContain("aces_tonemap");
  });
});
