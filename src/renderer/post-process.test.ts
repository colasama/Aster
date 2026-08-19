import { describe, expect, it } from "vitest";
import { defaultPostProcessParameters } from "./effect-parameters";
import { buildPostProcessUniforms } from "./post-process";

describe("post-process uniform packing", () => {
  it("keeps the WGSL vec4 layout stable for per-layer linear output", () => {
    const effects = defaultPostProcessParameters();
    effects.exposure = 1.25;
    effects.glow = 0.7;
    effects.pivot = 0.42;
    effects.lift = -0.03;
    effects.gain = 1.1;
    const uniforms = buildPostProcessUniforms(3840, 2160, 2.5, effects, 6, true);

    expect(uniforms).toHaveLength(24);
    expect([...uniforms.slice(0, 4)]).toEqual([3840, 2160, 2.5, 1.25]);
    expect(uniforms[8]).toBeCloseTo(0.7);
    expect(uniforms[16]).toBe(6);
    expect(uniforms[17]).toBe(1);
    expect([...uniforms.slice(20, 23)]).toEqual([
      expect.closeTo(0.42),
      expect.closeTo(-0.03),
      expect.closeTo(1.1),
    ]);
  });

  it("uses identity grading and display output by default", () => {
    const uniforms = buildPostProcessUniforms(1920, 1080, 0);
    expect(uniforms[3]).toBe(0);
    expect(uniforms[4]).toBe(1);
    expect(uniforms[5]).toBe(1);
    expect(uniforms[16]).toBe(0);
    expect(uniforms[17]).toBe(0);
    expect(uniforms[20]).toBeCloseTo(0.18);
    expect(uniforms[21]).toBe(0);
    expect(uniforms[22]).toBe(1);
  });
});
