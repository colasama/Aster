import { describe, expect, it } from "vitest";
import { activeComposition, createDemoProject } from "../core/project";
import { createEffect } from "../effects/registry";
import { collectPostProcessParameters } from "./effect-parameters";

describe("GPU effect parameter fusion", () => {
  it("collects enabled Looks and multi-pass controls into one bounded uniform block", () => {
    const composition = activeComposition(createDemoProject());
    composition.layers.forEach((entry) => {
      entry.effects = [];
    });
    const layer = composition.layers[0];
    const looks = createEffect("looks-color-lab");
    looks.parameters.temperature = 0.7;
    looks.parameters.grain = 0.12;
    looks.parameters.pivot = 0.43;
    looks.parameters.lift = -0.04;
    looks.parameters.gain = 1.12;
    const glow = createEffect("glow");
    glow.parameters.radius = 100;
    glow.parameters.intensity = 2;
    layer.effects.push(looks, glow);

    const parameters = collectPostProcessParameters(composition);

    expect(parameters.temperature).toBe(0.7);
    expect(parameters.grain).toBe(0.12);
    expect(parameters.glow).toBeCloseTo(2.35);
    expect(parameters.blur).toBe(8);
    expect(parameters.contrast).toBeCloseTo(1.08);
    expect(parameters.pivot).toBeCloseTo(0.43);
    expect(parameters.lift).toBeCloseTo(-0.04);
    expect(parameters.gain).toBeCloseTo(1.12);
  });

  it("ignores disabled effects and clamps unsafe parameter combinations", () => {
    const composition = activeComposition(createDemoProject());
    composition.layers.forEach((entry) => {
      entry.effects = [];
    });
    const layer = composition.layers[0];
    const disabled = createEffect("looks-color-lab");
    disabled.enabled = false;
    disabled.parameters.exposure = 8;
    const exposure = createEffect("exposure");
    exposure.parameters.exposure = 100;
    layer.effects.push(disabled, exposure);

    const parameters = collectPostProcessParameters(composition);

    expect(parameters.temperature).toBe(0);
    expect(parameters.exposure).toBe(12);
  });
});
