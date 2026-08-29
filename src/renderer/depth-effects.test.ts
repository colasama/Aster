import { describe, expect, it } from "vitest";
import {
  buildDepthEffectUniforms,
  DEFAULT_DEPTH_EFFECT_SETTINGS,
  depthEffectsShader,
} from "./depth-effects";

describe("GPU depth effects", () => {
  it("packs aligned, deterministic fog and lens settings", () => {
    const fog = buildDepthEffectUniforms("depthFog", 1920, 1080);
    const depthOfField = buildDepthEffectUniforms("depthOfField", 1920, 1080);
    expect(fog).toHaveLength(24);
    expect([...fog.slice(0, 4)]).toEqual([1920, 1080, 1, 32]);
    expect(depthOfField[2]).toBe(2);
    expect([...depthOfField.slice(12, 15)]).toEqual([
      ...DEFAULT_DEPTH_EFFECT_SETTINGS.cameraForward,
    ]);
    expect(depthOfField[15]).toBeCloseTo(DEFAULT_DEPTH_EFFECT_SETTINGS.focusDistance);
    expect(depthOfField[16]).toBe(DEFAULT_DEPTH_EFFECT_SETTINGS.focusAreaWidth);
    expect(depthOfField[17]).toBeCloseTo(DEFAULT_DEPTH_EFFECT_SETTINGS.aperture);
    expect(depthOfField[18]).toBe(DEFAULT_DEPTH_EFFECT_SETTINGS.filmSize);
    expect(depthOfField[19]).toBeCloseTo(DEFAULT_DEPTH_EFFECT_SETTINGS.zoom);
  });

  it("bounds invalid input before it reaches WebGPU", () => {
    const packed = buildDepthEffectUniforms("depthOfField", Number.NaN, Infinity, {
      ...DEFAULT_DEPTH_EFFECT_SETTINGS,
      fogColor: [-1, 20, Number.NaN],
      fogDensity: 9,
      cameraForward: [Number.NaN, Infinity, -Infinity],
      focusDistance: 0,
      filmSize: 0,
      maximumBlurRadius: 500,
      sampleCount: 200,
    });
    expect([...packed.slice(0, 2)]).toEqual([1, 1]);
    expect([...packed.slice(4, 8)]).toEqual([0, 16, 0, 1]);
    expect(packed[3]).toBe(64);
    expect([...packed.slice(12, 15)]).toEqual([0, 0, 1]);
    expect(packed[15]).toBeCloseTo(0.001);
    expect(packed[18]).toBeCloseTo(0.001);
    expect(packed[23]).toBe(256);
  });

  it("derives camera-space circles of confusion with a bounded GPU blur budget", () => {
    expect(depthEffectsShader).toContain("var world_position: texture_2d<f32>");
    expect(depthEffectsShader).toContain("textureLoad(world_position");
    expect(depthEffectsShader).toContain("1.0 - exp(-depth_distance * settings.fog.w)");
    expect(depthEffectsShader).toContain("dot(surface.xyz - settings.lens.xyz, forward)");
    expect(depthEffectsShader).toContain("for (var index = 0u; index < 64u");
    expect(depthEffectsShader).toContain("if (f32(index) >= sample_count) { break; }");
    expect(depthEffectsShader).toContain("sample_depth < center_depth");
  });
});
