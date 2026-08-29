import { describe, expect, it } from "vitest";
import {
  circleOfConfusionRadius,
  DEFAULT_CAMERA_OPTICS,
  normalizeCameraOptics,
} from "../core/camera-optics";
import {
  applyDepthOfFieldHighlight,
  buildDepthEffectUniforms,
  DEFAULT_DEPTH_EFFECT_SETTINGS,
  depthEffectCircleOfConfusion,
  depthEffectSettingsFromCameraOptics,
  depthEffectsShader,
  depthOfFieldDiffractionWeights,
  planLayeredDepthOfField,
  resolveLayeredDepthOfFieldColors,
} from "./depth-effects";

describe("GPU depth effects", () => {
  it("packs aligned, deterministic fog and lens settings", () => {
    const fog = buildDepthEffectUniforms("depthFog", 1920, 1080);
    const depthOfField = buildDepthEffectUniforms("depthOfField", 1920, 1080);
    expect(fog).toHaveLength(32);
    expect([...fog.slice(0, 4)]).toEqual([1920, 1080, 1, 32]);
    expect(depthOfField[2]).toBe(2);
    expect([...depthOfField.slice(12, 15)]).toEqual([
      ...DEFAULT_DEPTH_EFFECT_SETTINGS.cameraForward,
    ]);
    expect(depthOfField[15]).toBeCloseTo(DEFAULT_DEPTH_EFFECT_SETTINGS.focusDistance);
    expect(depthOfField[16]).toBe(DEFAULT_DEPTH_EFFECT_SETTINGS.focusAreaWidth);
    expect(depthOfField[17]).toBeCloseTo(DEFAULT_DEPTH_EFFECT_SETTINGS.aperture);
    expect(depthOfField[18]).toBe(DEFAULT_DEPTH_EFFECT_SETTINGS.transparencyTier);
    expect(depthOfField[19]).toBeCloseTo(DEFAULT_DEPTH_EFFECT_SETTINGS.zoom);
    expect([...depthOfField.slice(24, 28)]).toEqual([
      DEFAULT_DEPTH_EFFECT_SETTINGS.irisShapeCode,
      0,
      0,
      1,
    ]);
    expect([...depthOfField.slice(28, 32)]).toEqual([0, 0, 1, 1]);
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
    expect(packed[18]).toBe(DEFAULT_DEPTH_EFFECT_SETTINGS.transparencyTier);
    expect(packed[23]).toBe(256);
    expect(packed[24]).toBe(DEFAULT_DEPTH_EFFECT_SETTINGS.irisShapeCode);
  });

  it("derives camera-space circles of confusion with a bounded GPU blur budget", () => {
    expect(depthEffectsShader).toContain("var world_position: texture_2d<f32>");
    expect(depthEffectsShader).toContain("textureLoad(world_position");
    expect(depthEffectsShader).toContain("1.0 - exp(-depth_distance * settings.fog.w)");
    expect(depthEffectsShader).toContain("dot(surface.xyz - settings.lens.xyz, forward)");
    expect(depthEffectsShader).toContain("for (var index = 0u; index < 64u");
    expect(depthEffectsShader).toContain("if (f32(index) >= sample_count) { break; }");
    expect(depthEffectsShader).toContain("sample_depth < center_depth");
    expect(depthEffectsShader).toContain("var transparent_world_position: texture_2d<f32>");
    expect(depthEffectsShader).toContain("fn iris_boundary(angle: f32)");
    expect(depthEffectsShader).toContain("fn diffraction_weight(index: u32");
    expect(depthEffectsShader).toContain("5.0 * pow(radial_position, 8.0)");
    expect(depthEffectsShader).not.toContain("sample_uv_red");
    expect(depthEffectsShader).not.toContain("sample_uv_blue");
    expect(depthEffectsShader).toContain("var front_layer_color: texture_2d<f32>");
    expect(depthEffectsShader).toContain("var peeled_layer_color: texture_2d<f32>");
    expect(depthEffectsShader).toContain("fn residual_color_at(uv: vec2f)");
    expect(depthEffectsShader).toContain("raw.a >= 0.999 || settings.optics.z < 0.5");
    expect(depthEffectsShader).toContain("canonical_behind_front");
    expect(depthEffectsShader).toContain("accumulated_front += bokeh_sample");
    expect(depthEffectsShader).toContain("accumulated_peeled += bokeh_sample");
    expect(depthEffectsShader).toContain("front_result + behind_front * (1.0 - front_result.a)");
    expect(depthEffectsShader).toContain("settings.optics.w / max(settings.camera.w, 0.001)");
  });

  it("conserves highlight energy while moving diffraction toward the iris boundary", () => {
    const uniform = depthOfFieldDiffractionWeights(32, 0);
    const ring = depthOfFieldDiffractionWeights(32, 100);
    expect(uniform.reduce((sum, weight) => sum + weight, 0)).toBeCloseTo(1, 12);
    expect(ring.reduce((sum, weight) => sum + weight, 0)).toBeCloseTo(1, 12);
    expect(new Set(uniform.map((weight) => weight.toFixed(12))).size).toBe(1);
    expect(ring.slice(16).reduce((sum, weight) => sum + weight, 0)).toBeGreaterThan(
      ring.slice(0, 16).reduce((sum, weight) => sum + weight, 0),
    );
  });

  it("applies saturation and gain only to samples above the highlight threshold", () => {
    const shadow = [0.4, 0.2, 0.1] as const;
    expect(applyDepthOfFieldHighlight(shadow, 100, 1, 0)).toEqual(shadow);
    const highlight = applyDepthOfFieldHighlight([4, 1, 0.5], 50, 1, 0);
    expect(highlight[0]).toBeGreaterThan(4);
    expect(highlight[0]).toBeCloseTo(highlight[1]);
    expect(highlight[1]).toBeCloseTo(highlight[2]);
    expect(depthEffectsShader).toContain("let highlight_amount = smoothstep(");
    expect(depthEffectsShader).toContain("let highlight_color = mix(straight, saturated");
  });

  it("keeps two overlapping transparent focal planes distinct before compositing", () => {
    expect(planLayeredDepthOfField(-5, 0.5, 20, 0.5, 40)).toEqual({
      frontRadius: 5,
      peeledRadius: 20,
      fallbackRadius: 40,
      frontWeight: 0.5,
      peeledWeight: 0.25,
      fallbackWeight: 0.25,
    });
  });

  it("preserves canonical lit beauty for opaque fronts and separates transparent residuals", () => {
    expect(
      resolveLayeredDepthOfFieldColors([0.8, 0.6, 0.4, 1], [0.2, 0.2, 0.2, 1], [0, 0, 0, 0]).front,
    ).toEqual([0.8, 0.6, 0.4, 1]);
    const layered = resolveLayeredDepthOfFieldColors(
      [0.6, 0.3, 0.2, 1],
      [0.25, 0, 0, 0.5],
      [0, 0.6, 0, 1],
    );
    expect(layered.front).toEqual([0.25, 0, 0, 0.5]);
    expect(layered.peeled[1]).toBeCloseTo(0.6);
    expect(layered.residual).toEqual([0, 0, 0, 0]);
  });

  it("packs the same time-evaluated AE pixel optics consumed by the CPU CoC", () => {
    const optics = normalizeCameraOptics(
      {
        ...DEFAULT_CAMERA_OPTICS,
        depthOfField: true,
        zoom: 2400,
        aperture: 600,
        lockFocusToZoom: false,
        focusDistance: 1200,
        irisShape: "octagon",
        irisRotation: 45,
        irisRoundness: 25,
        irisAspectRatio: 2,
        irisDiffractionFringe: 40,
      },
      1920,
    );
    const settings = {
      ...DEFAULT_DEPTH_EFFECT_SETTINGS,
      ...depthEffectSettingsFromCameraOptics(optics, 1920, 960),
    };
    const packed = buildDepthEffectUniforms("depthOfField", 960, 540, settings);
    expect(optics.aperture).toBe(600);
    expect(packed[15]).toBe(1200);
    expect(packed[17]).toBe(300);
    expect(packed[19]).toBe(2400);
    expect(packed[24]).toBe(7);
    expect(packed[25]).toBeCloseTo(Math.PI / 4);
    expect(packed[26]).toBeCloseTo(0.25);
    expect(packed[27]).toBeCloseTo(2);
    expect(packed[28]).toBeCloseTo(0.4);
    expect(settings.maximumBlurRadius).toBe(128);
  });

  it.each([
    [1920, 1],
    [960, 0.5],
    [480, 0.25],
  ])("scales CPU and GPU pixel-domain CoC at a %ipx render width", (renderWidth, scale) => {
    const optics = normalizeCameraOptics(
      {
        ...DEFAULT_CAMERA_OPTICS,
        depthOfField: true,
        lockFocusToZoom: false,
        focusDistance: 1200,
        aperture: 100,
      },
      1920,
    );
    const settings = depthEffectSettingsFromCameraOptics(optics, 1920, renderWidth);
    expect(settings.aperture).toBeCloseTo(100 * scale);
    expect(settings.maximumBlurRadius).toBeCloseTo(256 * scale);
    expect(depthEffectCircleOfConfusion(settings, 2400)).toBeCloseTo(
      circleOfConfusionRadius(optics, 0, 2400, 1920, renderWidth),
      8,
    );
  });
});
