import { describe, expect, it } from "vitest";
import { defaultPostProcessParameters } from "./effect-parameters";

describe("neutral post-process uniforms", () => {
  it("keeps all ordered effect work in the opcode program", () => {
    expect(defaultPostProcessParameters()).toEqual({
      exposure: 0,
      contrast: 1,
      saturation: 1,
      temperature: 0,
      tint: 0,
      glow: 0,
      glowThreshold: 0.8,
      blur: 0,
      chromatic: 0,
      vignette: 0,
      grain: 0,
      gamma: 1,
      fade: 0,
      pivot: 0.18,
      lift: 0,
      gain: 1,
    });
  });

  it("returns a fresh uniform object for every layer pass", () => {
    const first = defaultPostProcessParameters();
    first.exposure = 3;
    expect(defaultPostProcessParameters().exposure).toBe(0);
  });
});
