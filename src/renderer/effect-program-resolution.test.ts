import { expect, it } from "vitest";
import { createLayerForComposition } from "../core/layer-factory";
import { createBlankProject } from "../core/project";
import { createEffect } from "../effects/registry";
import { compileEffectProgram, EffectOpcode } from "./effect-program";

it("preserves composition-space radii, feathering, and angles across preview resolutions", () => {
  const composition = createBlankProject().compositions[0];
  const layer = createLayerForComposition("image", composition);
  const sphere = createEffect("sphere");
  sphere.parameterKeyframes = {
    radius: [
      { id: "a", time: 0, value: 100, interpolation: "linear" },
      { id: "b", time: 2, value: 300, interpolation: "linear" },
    ],
  };
  sphere.parameters.rotation = 90;
  sphere.mask = {
    shape: "ellipse",
    center: [40, 60],
    size: [80, 70],
    feather: 16,
    opacity: 80,
    invert: false,
  };
  layer.effects = [sphere];
  const original = structuredClone(sphere);
  const full = compileEffectProgram(composition, 1, [layer]);
  const half = compileEffectProgram(composition, 1, [layer], 0.5);
  expect(full.data[0]).toBe(EffectOpcode.MaskBegin);
  expect(half.data[5]).toBe(full.data[5] / 2);
  expect(half.data[1]).toBe(full.data[1]);
  expect(full.data[16]).toBe(EffectOpcode.Sphere);
  expect(full.data[19]).toBe(200);
  expect(half.data[19] / 0.5).toBe(full.data[19]);
  expect(half.data[20]).toBe(full.data[20]);
  expect(half.data[21]).toBe(full.data[21]);
  expect(sphere).toEqual(original);
});
