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
    expect(fog).toHaveLength(12);
    expect([...fog.slice(0, 4)]).toEqual([1920, 1080, 1, 0]);
    expect(depthOfField[2]).toBe(2);
    expect([...depthOfField.slice(8)]).toEqual([
      DEFAULT_DEPTH_EFFECT_SETTINGS.focusDistance,
      DEFAULT_DEPTH_EFFECT_SETTINGS.focusRange,
      DEFAULT_DEPTH_EFFECT_SETTINGS.maximumBlurRadius,
      DEFAULT_DEPTH_EFFECT_SETTINGS.fogStart,
    ]);
  });

  it("bounds invalid input before it reaches WebGPU", () => {
    const packed = buildDepthEffectUniforms("depthOfField", Number.NaN, Infinity, {
      ...DEFAULT_DEPTH_EFFECT_SETTINGS,
      fogColor: [-1, 20, Number.NaN],
      fogDensity: 9,
      focusRange: 0,
      maximumBlurRadius: 200,
    });
    expect([...packed.slice(0, 2)]).toEqual([1, 1]);
    expect([...packed.slice(4, 8)]).toEqual([0, 16, 0, 1]);
    expect(packed[9]).toBeCloseTo(0.001);
    expect(packed[10]).toBe(48);
  });

  it("samples real world positions and uses a fixed GPU blur budget", () => {
    expect(depthEffectsShader).toContain("var world_position: texture_2d<f32>");
    expect(depthEffectsShader).toContain("textureLoad(world_position");
    expect(depthEffectsShader).toContain("1.0 - exp(-depth_distance * settings.fog.w)");
    expect(depthEffectsShader).toContain("index < 16u");
    expect(depthEffectsShader).toContain("focus_error / settings.lens.y");
  });
});
