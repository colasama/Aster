import { describe, expect, it } from "vitest";
import {
  acesToneMap,
  compositePremultiplied,
  linearChannelToSrgb,
  linearToSrgb,
  premultiply,
  srgbChannelToLinear,
  srgbToLinear,
  unpremultiply,
} from "./color-management";

describe("linear working color reference", () => {
  it("matches IEC sRGB transfer reference points", () => {
    expect(srgbChannelToLinear(0.04045)).toBeCloseTo(0.0031308, 7);
    expect(srgbChannelToLinear(0.5)).toBeCloseTo(0.21404114, 7);
    expect(linearChannelToSrgb(0.0031308)).toBeCloseTo(0.04044994, 7);
    expect(linearChannelToSrgb(0.21404114)).toBeCloseTo(0.5, 7);
  });

  it("roundtrips representative sRGB colors", () => {
    const samples = [
      [0, 0, 0],
      [1, 1, 1],
      [0.18, 0.5, 0.9],
      [0.04045, 0.003, 0.75],
    ] as const;
    for (const sample of samples) {
      const roundtrip = linearToSrgb(srgbToLinear(sample));
      roundtrip.forEach((channel, index) => {
        expect(channel).toBeCloseTo(sample[index], 6);
      });
    }
  });

  it("composites premultiplied colors in linear light", () => {
    const red = premultiply([1, 0, 0, 0.5]);
    const blue = premultiply([0, 0, 1, 1]);
    expect(compositePremultiplied(red, blue)).toEqual([0.5, 0, 0.5, 1]);
    expect(unpremultiply(premultiply([0.2, 0.4, 0.8, 0.25]))).toEqual([0.2, 0.4, 0.8, 0.25]);
    expect(unpremultiply([1, 1, 1, 0])).toEqual([0, 0, 0, 0]);
  });

  it("matches the opt-in WGSL ACES tone-map effect and preserves HDR monotonicity", () => {
    expect(acesToneMap([0, 1, 16])).toEqual([0, 0.8037974683544302, 1]);
    const ramp = [0, 0.18, 1, 4, 16].map((value) => acesToneMap([value, 0, 0])[0]);
    expect(ramp).toEqual([...ramp].sort((left, right) => left - right));
  });
});
