import { describe, expect, it } from "vitest";
import { activeComposition, createDemoProject } from "../core/project";
import { createEffect } from "../effects/registry";
import {
  compileEffectProgram,
  EffectOpcode,
  FLOATS_PER_EFFECT_OPERATION,
  MAX_EFFECT_OPERATIONS,
} from "./effect-program";

describe("GPU effect program compiler", () => {
  it("preserves enabled effect order and packs color parameters", () => {
    const composition = activeComposition(createDemoProject());
    composition.layers.forEach((layer) => {
      layer.effects = [];
    });
    const tint = createEffect("tint");
    tint.parameters.black = 0xff0000;
    tint.parameters.white = 0x00ff00;
    const posterize = createEffect("posterize");
    composition.layers[0].effects.push(tint, posterize);

    const program = compileEffectProgram(composition);

    expect(program.count).toBe(2);
    expect(program.data[0]).toBe(EffectOpcode.Tint);
    expect(program.data[1]).toBe(1);
    expect(program.data[2]).toBe(0);
    expect(program.data[3]).toBe(0);
    expect(program.data[5]).toBe(0);
    expect(program.data[6]).toBe(1);
    expect(program.data[FLOATS_PER_EFFECT_OPERATION]).toBe(EffectOpcode.Posterize);
  });

  it("skips disabled effects and caps untrusted project programs", () => {
    const composition = activeComposition(createDemoProject());
    composition.layers.forEach((layer) => {
      layer.effects = [];
    });
    const layer = composition.layers[0];
    for (let index = 0; index < MAX_EFFECT_OPERATIONS + 8; index += 1) {
      layer.effects.push(createEffect("posterize"));
    }
    layer.effects[0].enabled = false;

    expect(compileEffectProgram(composition).count).toBe(MAX_EFFECT_OPERATIONS);
  });

  it.each([
    ["bilateral-blur", EffectOpcode.BilateralBlur],
    ["echo", EffectOpcode.Echo],
    ["motion-trails", EffectOpcode.MotionTrails],
    ["particle-world", EffectOpcode.ParticleWorld],
    ["fill", EffectOpcode.Fill],
    ["invert", EffectOpcode.Invert],
    ["threshold", EffectOpcode.Threshold],
    ["noise", EffectOpcode.Noise],
    ["mirror", EffectOpcode.Mirror],
    ["motion-tile", EffectOpcode.MotionTile],
    ["venetian-blinds", EffectOpcode.VenetianBlinds],
    ["gradient-ramp", EffectOpcode.GradientRamp],
    ["drop-shadow", EffectOpcode.DropShadow],
    ["tritone", EffectOpcode.Tritone],
    ["lens-distortion", EffectOpcode.LensDistortion],
    ["black-white", EffectOpcode.BlackWhite],
  ])("compiles %s into its dedicated GPU opcode", (type, opcode) => {
    const composition = activeComposition(createDemoProject());
    composition.layers.forEach((layer) => {
      layer.effects = [];
    });
    composition.layers[0].effects = [createEffect(type)];
    const program = compileEffectProgram(composition);
    expect(program.count).toBe(1);
    expect(program.data[0]).toBe(opcode);
  });
});
