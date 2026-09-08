import { describe, expect, it } from "vitest";
import { createBlankProject } from "../../core/project/project";
import { createParticleLayerForComposition } from "../../core/scene/bundled-particle";
import {
  createDefaultCameraSettings,
  evaluateCameraSettings,
} from "../../core/scene/camera-settings";
import { flattenSceneLayers } from "../../core/scene/scene-evaluation";
import type { SceneCamera } from "../geometry/geometry";
import { bundledParticleDefinition } from "./bundled-particle-generator";
import {
  buildSceneGeneratorContext,
  buildSceneGeneratorParameters,
  SCENE_GENERATOR_CONTEXT_BYTES,
} from "./scene-generator-abi";

describe("scene generator ABI packing", () => {
  it("packs time, transform, camera, count, seed, and render IDs into the stable context", () => {
    const project = createBlankProject();
    const composition = project.compositions[0];
    const layer = createParticleLayerForComposition(composition);
    layer.timeOffset = 2;
    layer.transform.position[0] = { mode: "static", value: 320 };
    layer.threeDimensional = true;
    composition.layers = [layer];
    const scene = flattenSceneLayers(composition, project, 3)[0];
    const context = buildSceneGeneratorContext(
      { ...scene, localTime: 5 },
      composition,
      sceneCamera(),
      960,
      540,
      3,
      1 / 30,
      2048,
    );
    expect(context.byteLength).toBe(SCENE_GENERATOR_CONTEXT_BYTES);
    const floats = new Float32Array(context);
    const integers = new Uint32Array(context);
    expect([...floats.slice(0, 4)]).toEqual([960, 540, 3, 5]);
    expect(floats[4]).toBeCloseTo(1 / 30);
    expect(floats[5]).toBe(0);
    expect(integers[6]).toBe(2048);
    expect(integers[7]).not.toBe(0);
    expect(floats[8]).toBe(320);
    expect(floats[15]).toBe(1);
    expect([...floats.slice(20, 23)]).toEqual([10, 20, 30]);
    expect([...floats.slice(24, 27)]).toEqual([4, 5, 6]);
    expect(floats[28]).toBe(1);
    expect(floats[29]).toBeCloseTo(Math.PI / 3);
    expect(floats[30]).toBe(720);
    expect(floats[31]).toBeCloseTo(composition.width / (2 * Math.tan(Math.PI / 6)));
    expect(integers[36]).not.toBe(0);
    expect(Math.hypot(...floats.slice(40, 43))).toBeCloseTo(1);
    expect(Math.hypot(...floats.slice(44, 47))).toBeCloseTo(1);
    expect(Math.hypot(...floats.slice(48, 51))).toBeCloseTo(1);
  });

  it("packs manifest parameters by declaration order", () => {
    const instance = createParticleLayerForComposition(
      createBlankProject().compositions[0],
    ).generator;
    if (!instance) throw new Error("Expected generator fixture");
    const packed = buildSceneGeneratorParameters(bundledParticleDefinition, instance);
    expect(packed[0]).toBe(0);
    expect(packed[2 * 4]).toBe(100_000);
    expect([...packed.slice(6 * 4, 6 * 4 + 3)]).toEqual([0, 0, 0]);
  });

  it("clamps values to manifest bounds and substitutes typed defaults", () => {
    const instance = createParticleLayerForComposition(
      createBlankProject().compositions[0],
    ).generator;
    if (!instance) throw new Error("Expected generator fixture");
    instance.parameters.count = 4_000_000;
    instance.parameters.renderMode = "unknown";
    instance.parameters.startColor = [Number.NaN, 0, 0];
    const packed = buildSceneGeneratorParameters(bundledParticleDefinition, instance);
    expect(packed[0]).toBe(0);
    expect(packed[2 * 4]).toBe(1_000_000);
    expect(packed[14 * 4]).toBe(1);
    expect(packed[14 * 4 + 1]).toBeCloseTo(0.48);
    expect(packed[14 * 4 + 2]).toBeCloseTo(0.12);
  });
});

function sceneCamera(): SceneCamera {
  const settings = createDefaultCameraSettings(1920, 1080);
  settings.mode = "oneNode";
  settings.projection = "orthographic";
  settings.zoom = { mode: "static", value: 1920 / (2 * Math.tan(Math.PI / 6)) };
  settings.orthographicSize = { mode: "static", value: 720 };
  const transform = {
    position: [10, 20, 30] as [number, number, number],
    rotation: [4, 5, 6] as [number, number, number],
    scale: [100, 100, 100] as [number, number, number],
    anchor: [0, 0, 0] as [number, number, number],
    opacity: 1,
  };
  return {
    transform,
    settings,
    ...evaluateCameraSettings(settings, transform, 0, 1920),
  };
}
