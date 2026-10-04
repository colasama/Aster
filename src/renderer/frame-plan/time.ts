import { gcd, integer, object, requirePlan } from "./canonical";
import type { BinaryRationalTime, FrameTime } from "./types";

/** Captures the exact finite binary64 request, including either signed zero. */
export function frameTimeFromNumber(value: number): BinaryRationalTime {
  requirePlan(Number.isFinite(value), "invalid_rational", "Frame time must be finite");
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, value, false);
  const encodedHigh = view.getUint32(0, false);
  const negative = encodedHigh >>> 31 !== 0;
  const encodedExponent = (encodedHigh >>> 20) & 0x7ff;
  let high = encodedHigh & 0x000f_ffff;
  let low = view.getUint32(4, false);
  let exponent = encodedExponent === 0 ? -1074 : encodedExponent - 1075;
  if (encodedExponent !== 0) high |= 0x0010_0000;
  if (high === 0 && low === 0) exponent = 0;
  else {
    const nonzeroWord = low === 0 ? high : low;
    const shift = (low === 0 ? 32 : 0) + 31 - Math.clz32((nonzeroWord & -nonzeroWord) >>> 0);
    // JavaScript masks shift counts to five bits, so zero and whole words are separate cases.
    if (shift !== 0) {
      if (shift < 32) {
        low = ((low >>> shift) | (high << (32 - shift))) >>> 0;
        high >>>= shift;
      } else if (shift === 32) {
        low = high;
        high = 0;
      } else {
        low = high >>> (shift - 32);
        high = 0;
      }
    }
    exponent += shift;
  }
  const significand = high * 0x1_0000_0000 + low;
  return { kind: "binary_rational", negative, significand, exponent };
}

export function validateFrameTime(value: unknown): FrameTime {
  requirePlan(
    value !== null && typeof value === "object" && !Array.isArray(value),
    "invalid_rational",
    "Frame time must be a tagged object",
  );
  const kind = (value as Record<string, unknown>).kind;
  if (kind === "rational") {
    const time = object(value, ["kind", "value", "scale"]);
    const numerator = integer(time.value, -Number.MAX_SAFE_INTEGER);
    const scale = integer(time.scale, 1, 0xffff_ffff);
    requirePlan(
      gcd(BigInt(numerator), BigInt(scale)) === 1n,
      "invalid_rational",
      "Time must be a reduced rational",
    );
    return { kind, value: numerator, scale };
  }
  requirePlan(kind === "binary_rational", "unknown_variant", "Unknown frame time variant");
  const time = object(value, ["kind", "negative", "significand", "exponent"]);
  requirePlan(typeof time.negative === "boolean", "invalid_rational", "Invalid binary time sign");
  const significand = integer(time.significand);
  const exponent = integer(time.exponent, -1074, 1023);
  const high = Math.floor(significand / 0x1_0000_0000);
  const low = significand >>> 0;
  const highestBit = high === 0 ? 31 - Math.clz32(low) : 63 - Math.clz32(high);
  requirePlan(
    significand === 0 ? exponent === 0 : (low & 1) === 1 && highestBit + exponent <= 1023,
    "invalid_rational",
    "Binary time must be a canonical finite binary64 value",
  );
  return { kind, negative: time.negative, significand, exponent };
}

/** Rebuilds IEEE-754 bits without decimal conversion or an overflowing intermediate power. */
export function frameTimeToNumber(input: FrameTime): number {
  const time = validateFrameTime(input);
  if (time.kind === "rational") return time.value / time.scale;
  let high = Math.floor(time.significand / 0x1_0000_0000);
  let low = time.significand >>> 0;
  if (time.significand !== 0) {
    const highestBit = high === 0 ? 31 - Math.clz32(low) : 63 - Math.clz32(high);
    const exponent = highestBit + time.exponent;
    const normal = exponent >= -1022;
    const shift = normal ? 52 - highestBit : time.exponent + 1074;
    if (shift !== 0) {
      if (shift < 32) {
        high = ((high << shift) | (low >>> (32 - shift))) >>> 0;
        low = (low << shift) >>> 0;
      } else if (shift === 32) {
        high = low;
        low = 0;
      } else {
        high = (low << (shift - 32)) >>> 0;
        low = 0;
      }
    }
    if (normal) high = ((high & 0x000f_ffff) | ((exponent + 1023) << 20)) >>> 0;
  }
  if (time.negative) high = (high | 0x8000_0000) >>> 0;
  const view = new DataView(new ArrayBuffer(8));
  view.setUint32(0, high, false);
  view.setUint32(4, low, false);
  return view.getFloat64(0, false);
}
