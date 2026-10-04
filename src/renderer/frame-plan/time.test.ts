import { describe, expect, it } from "vitest";
import { frameTimeFromNumber, frameTimeToNumber, validateFrameTime } from "./time";
import type { BinaryRationalTime, FrameTime } from "./types";

function bits(value: number): bigint {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, value);
  return view.getBigUint64(0);
}

function fromBits(value: bigint): number {
  const view = new DataView(new ArrayBuffer(8));
  view.setBigUint64(0, value);
  return view.getFloat64(0);
}

function canonicalHeaderFromBits(raw: bigint): BinaryRationalTime {
  const encodedExponent = Number((raw >> 52n) & 0x7ffn);
  const mantissa = (raw & 0x000f_ffff_ffff_ffffn) | (encodedExponent === 0 ? 0n : 1n << 52n);
  const negative = (raw & (1n << 63n)) !== 0n;
  if (mantissa === 0n) return { kind: "binary_rational", negative, significand: 0, exponent: 0 };

  // The oracle normalizes the raw integer's digit string, independently of word arithmetic.
  const digits = mantissa.toString(2);
  const significantDigits = digits.replace(/0+$/, "");
  return {
    kind: "binary_rational",
    negative,
    significand: Number(BigInt(`0b${significantDigits}`)),
    exponent:
      (encodedExponent === 0 ? -1074 : encodedExponent - 1075) +
      digits.length -
      significantDigits.length,
  };
}

function bitsFromCanonicalHeader(time: BinaryRationalTime): bigint {
  const sign = time.negative ? 1n << 63n : 0n;
  // Count exact integer multiples of the smallest subnormal, without binary64 arithmetic.
  const units = BigInt(time.significand) << BigInt(time.exponent + 1074);
  if (units < 1n << 52n) return sign | units;
  const encodedExponent = units.toString(2).length - 52;
  const shift = BigInt(encodedExponent - 1);
  const normalized = units >> shift;
  if (encodedExponent >= 2047 || normalized << shift !== units)
    throw new Error("The test header must have an exact finite binary64 representation");
  return sign | (BigInt(encodedExponent) << 52n) | (normalized - (1n << 52n));
}

describe("exact frame request time", () => {
  it("retains every bit of signed zeros, seeks, fractional-rate arithmetic and finite extremes", () => {
    const samples = [
      0,
      -0,
      0.1,
      -0.1,
      1 / 3,
      -1 / 3,
      (137 * 1001) / 24000,
      (713 * 1001) / 30000,
      Number.MIN_VALUE,
      -Number.MIN_VALUE,
      Number.MAX_VALUE,
      -Number.MAX_VALUE,
      fromBits(0x000f_ffff_ffff_ffffn),
      fromBits(0x0010_0000_0000_0000n),
      fromBits(bits(0.1) - 1n),
      fromBits(bits(0.1) + 1n),
    ];
    for (const sample of samples) {
      const time = frameTimeFromNumber(sample);
      expect(bits(frameTimeToNumber(time))).toBe(bits(sample));
      expect(validateFrameTime(JSON.parse(JSON.stringify(time)))).toEqual(time);
    }
    expect(frameTimeFromNumber(-0)).toEqual({
      kind: "binary_rational",
      negative: true,
      significand: 0,
      exponent: 0,
    });
    expect(frameTimeFromNumber(0.1)).toEqual({
      kind: "binary_rational",
      negative: false,
      significand: 3602879701896397,
      exponent: -55,
    });
  });

  it("round-trips both signs and exponent-stratified binary64 significands without rounding", () => {
    let seed = 0x1234_5678_9abc_def0n;
    for (let exponent = 0n; exponent < 2047n; exponent++) {
      seed = (seed * 6364136223846793005n + 1442695040888963407n) & 0xffff_ffff_ffff_ffffn;
      for (const fraction of [0n, 1n, 0x000f_ffff_ffff_ffffn, seed & 0x000f_ffff_ffff_ffffn]) {
        for (const sign of [0n, 1n << 63n]) {
          const original = sign | (exponent << 52n) | fraction;
          const time = frameTimeFromNumber(fromBits(original));
          expect(time).toEqual(canonicalHeaderFromBits(original));
          expect(bits(frameTimeToNumber(time))).toBe(original);
        }
      }
    }
  });

  it("normalizes every mantissa trailing-zero position and carries across the low word", () => {
    const fractions = new Set<bigint>([
      0n,
      0x7fff_ffffn,
      0x8000_0000n,
      0xffff_ffffn,
      0x1_0000_0000n,
      0x1_0000_0001n,
      0x000f_ffff_ffff_ffffn,
    ]);
    for (let zeroBits = 0n; zeroBits < 52n; zeroBits++) fractions.add(1n << zeroBits);
    for (const encodedExponent of [0n, 1n, 1023n, 2046n]) {
      for (const fraction of fractions) {
        for (const sign of [0n, 1n << 63n]) {
          const raw = sign | (encodedExponent << 52n) | fraction;
          expect(frameTimeFromNumber(fromBits(raw))).toEqual(canonicalHeaderFromBits(raw));
        }
      }
    }
  });

  it("decodes independent canonical headers across every bit width and exponent boundary", () => {
    const significands = new Set<bigint>([
      0x7fff_ffffn,
      0x8000_0001n,
      0xffff_ffffn,
      0x1_0000_0001n,
      0x000f_ffff_ffff_ffffn,
      0x0010_0000_0000_0001n,
      0x001f_ffff_ffff_ffffn,
    ]);
    for (let width = 1n; width <= 53n; width++) {
      significands.add((1n << (width - 1n)) | 1n);
      significands.add((1n << width) - 1n);
    }
    for (const significand of significands) {
      const highestBit = significand.toString(2).length - 1;
      const exponents = new Set([
        -1074,
        -1023 - highestBit,
        -1022 - highestBit,
        -1021 - highestBit,
        -highestBit,
        1023 - highestBit,
      ]);
      for (const exponent of exponents) {
        if (exponent < -1074) continue;
        for (const negative of [false, true]) {
          const time: BinaryRationalTime = {
            kind: "binary_rational",
            negative,
            significand: Number(significand),
            exponent,
          };
          expect(bits(frameTimeToNumber(time))).toBe(bitsFromCanonicalHeader(time));
        }
      }
    }
    for (const negative of [false, true]) {
      const time: BinaryRationalTime = {
        kind: "binary_rational",
        negative,
        significand: 0,
        exponent: 0,
      };
      expect(bits(frameTimeToNumber(time))).toBe(negative ? 0x8000_0000_0000_0000n : 0n);
      for (let exponent = -1074; exponent <= 1023; exponent++) {
        const power = { ...time, significand: 1, exponent };
        expect(bits(frameTimeToNumber(power))).toBe(bitsFromCanonicalHeader(power));
      }
      for (const [significand, exponent] of [
        [1, 1024],
        [0x1_0000_0001, 992],
        [Number.MAX_SAFE_INTEGER, 972],
      ]) {
        expect(() => frameTimeToNumber({ ...time, significand, exponent })).toThrow();
      }
    }
  });

  it("accepts only canonical tagged finite time values", () => {
    const valid = { kind: "binary_rational", negative: false, significand: 1, exponent: 0 };
    for (const time of [
      null,
      {},
      { value: 1, scale: 1 },
      { ...valid, unknown: 1 },
      { ...valid, kind: "binary" },
      { ...valid, negative: 0 },
      { ...valid, significand: 2 },
      { ...valid, significand: -1 },
      { ...valid, significand: 1.5 },
      { ...valid, significand: Number.MAX_SAFE_INTEGER + 1 },
      { ...valid, significand: -0 },
      { ...valid, significand: 0, exponent: 1 },
      { ...valid, exponent: -0 },
      { ...valid, exponent: -1075 },
      { ...valid, exponent: 1024 },
      { ...valid, significand: 3, exponent: 1023 },
      { kind: "rational", value: -0, scale: 1 },
      { kind: "rational", value: 2, scale: 2 },
      { kind: "rational", value: 1, scale: 0 },
      { kind: "rational", value: 1, scale: 0x1_0000_0000 },
    ]) {
      expect(() => validateFrameTime(time)).toThrow();
      expect(() => frameTimeToNumber(time as FrameTime)).toThrow();
    }
    for (const value of [NaN, Infinity, -Infinity])
      expect(() => frameTimeFromNumber(value)).toThrow(/finite/);
    expect(frameTimeToNumber({ kind: "rational", value: -1001, scale: 1000 })).toBe(-1.001);
  });
});
