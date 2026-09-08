import { describe, expect, it } from "vitest";
import { activeComposition, createDemoProject } from "../../core/project/project";
import { createEffect } from "../../effects/registry";
import { compileEffectProgram, EffectOpcode } from "./effect-program";

describe("multi-stop gradient", () => {
  it("packs crossing stops with their colors and evaluates color channels at arbitrary times", () => {
    const composition = activeComposition(createDemoProject());
    const effect = createEffect("multi-stop-gradient");
    for (const layer of composition.layers) layer.effects = [];
    composition.layers[0].effects = [effect];
    Object.assign(effect.parameters, { position2: 90, position3: 20, position4: 60 });
    effect.parameters.mapping = 2;
    effect.parameterKeyframes = {
      color1: [
        { id: "red", time: 0, value: 0xff0000, interpolation: "linear" },
        { id: "blue", time: 2, value: 0x0000ff, interpolation: "linear" },
      ],
    };
    const atEnd = compileEffectProgram(composition, 2);
    const middle = compileEffectProgram(composition, 1);
    expect(middle.count).toBe(1);
    expect(middle.data[0]).toBe(EffectOpcode.MultiStopGradient);
    expect(middle.data[5]).toBe(0x800080);
    expect(atEnd.data[5]).toBe(0x0000ff);
    expect([...middle.data.slice(6, 9)]).toEqual([
      effect.parameters.color3,
      effect.parameters.color4,
      effect.parameters.color2,
    ]);
    expect(middle.data[10]).toBeCloseTo(0.2);
    expect(middle.data[11]).toBeCloseTo(0.6);
    expect(middle.data[12]).toBeCloseTo(0.9);
    expect(middle.data[15]).toBe(2);
    expect([...compileEffectProgram(composition, 1).data]).toEqual([...middle.data]);
    // Normalized endpoints and stops remain identical at reduced preview resolution.
    expect([...compileEffectProgram(composition, 1, composition.layers, 0.5).data]).toEqual([
      ...middle.data,
    ]);
  });
});
