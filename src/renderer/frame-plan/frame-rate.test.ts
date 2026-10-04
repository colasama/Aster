import { describe, expect, it } from "vitest";
import { frameRateFromNumbers, validateFrameRate } from "./frame-rate";
import { frameTimeFromNumber, frameTimeToNumber } from "./time";

describe("exact frame rate metadata", () => {
  it("normalizes the full positive u32 domain without signed truncation or loss of ratio", () => {
    for (const [numerator, denominator, expectedNumerator, expectedDenominator] of [
      [30, 1, 30, 1],
      [48000, 2002, 24000, 1001],
      [0xffff_ffff, 0xffff_ffff, 1, 1],
      [0xffff_ffff, 3, 1431655765, 1],
      [0xffff_fffe, 0x8000_0000, 2147483647, 1073741824],
      [0xffff_ffff, 0xffff_fffe, 4294967295, 4294967294],
      [1, 0xffff_ffff, 1, 4294967295],
      [2971215073, 1836311903, 2971215073, 1836311903],
    ]) {
      const input = Object.freeze({ numerator, denominator });
      const rate = frameRateFromNumbers(input);
      expect(rate).toEqual({
        kind: "rational",
        numerator: expectedNumerator,
        denominator: expectedDenominator,
      });
      expect(validateFrameRate(rate)).toEqual(rate);
      if (rate.kind !== "rational") throw new Error("Expected a bounded rational");
      expect(BigInt(rate.numerator) * BigInt(denominator)).toBe(
        BigInt(rate.denominator) * BigInt(numerator),
      );
    }
  });

  it("keeps exact fallback normalization for integers above u32 and mixed fractional inputs", () => {
    for (const input of [
      { numerator: 0x1_0000_0000, denominator: 2 },
      { numerator: 0x8000_0000, denominator: 1 },
    ])
      expect(frameRateFromNumbers(input)).toEqual({
        kind: "rational",
        numerator: 0x8000_0000,
        denominator: 1,
      });
    expect(frameRateFromNumbers({ numerator: 1, denominator: 0x1_0000_0000 })).toEqual({
      kind: "binary_ratio",
      numerator: frameTimeFromNumber(1),
      denominator: frameTimeFromNumber(0x1_0000_0000),
    });
    expect(frameRateFromNumbers({ numerator: 30, denominator: 0.5 })).toEqual({
      kind: "rational",
      numerator: 60,
      denominator: 1,
    });
  });

  it("reduces only exact ratios that fit the bounded rational branch", () => {
    for (const input of [
      { numerator: 48000, denominator: 2002 },
      { numerator: 24000, denominator: 1001 },
    ])
      expect(frameRateFromNumbers(input)).toEqual({
        kind: "rational",
        numerator: 24000,
        denominator: 1001,
      });
    expect(frameRateFromNumbers({ numerator: 7.5, denominator: 0.25 })).toEqual({
      kind: "rational",
      numerator: 30,
      denominator: 1,
    });
    expect(
      frameRateFromNumbers({ numerator: Number.MAX_VALUE, denominator: Number.MAX_VALUE }),
    ).toEqual({
      kind: "rational",
      numerator: 1,
      denominator: 1,
    });
  });

  it("preserves positive finite source scalars when an exact bounded ratio is unavailable", () => {
    for (const input of [
      { numerator: 29.97, denominator: 1 },
      { numerator: Number.MIN_VALUE, denominator: Number.MAX_VALUE },
      { numerator: Number.MAX_VALUE, denominator: Number.MIN_VALUE },
      { numerator: 0.1, denominator: 0.3 },
    ]) {
      const rate = frameRateFromNumbers(input);
      expect(rate.kind).toBe("binary_ratio");
      if (rate.kind !== "binary_ratio") throw new Error("Expected binary source scalars");
      expect(frameTimeToNumber(rate.numerator)).toBe(input.numerator);
      expect(frameTimeToNumber(rate.denominator)).toBe(input.denominator);
      expect(validateFrameRate(rate)).toEqual(rate);
    }
  });

  it("rejects nonpositive/nonfinite sources, untagged rates and invalid binary components", () => {
    for (const bad of [0, -0, -1, NaN, Infinity]) {
      expect(() => frameRateFromNumbers({ numerator: bad, denominator: 1 })).toThrow();
      expect(() => frameRateFromNumbers({ numerator: 1, denominator: bad })).toThrow();
    }
    for (const rate of [
      { numerator: 30, denominator: 1 },
      { kind: "rational", numerator: 60, denominator: 2 },
      { kind: "rational", numerator: 0x1_0000_0000, denominator: 1 },
      {
        kind: "binary_ratio",
        numerator: frameTimeFromNumber(-1),
        denominator: frameTimeFromNumber(1),
      },
      {
        kind: "binary_ratio",
        numerator: frameTimeFromNumber(0),
        denominator: frameTimeFromNumber(1),
      },
      {
        kind: "binary_ratio",
        numerator: frameTimeFromNumber(1),
        denominator: { kind: "rational", value: 1, scale: 1 },
      },
    ])
      expect(() => validateFrameRate(rate)).toThrow();
  });
});
