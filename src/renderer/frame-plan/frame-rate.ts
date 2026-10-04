import { gcd, integer, object, requirePlan } from "./canonical";
import { frameTimeFromNumber, validateFrameTime } from "./time";
import type { FrameRate, RationalFrameRate } from "./types";

/** Normalizes the exact ratio only when it fits the bounded rational wire branch. */
export function frameRateFromNumbers(input: RationalFrameRate): FrameRate {
  const { numerator: sourceNumerator, denominator: sourceDenominator } = input;
  requirePlan(
    Number.isFinite(sourceNumerator) &&
      sourceNumerator > 0 &&
      Number.isFinite(sourceDenominator) &&
      sourceDenominator > 0,
    "invalid_rational",
    "Frame rate scalars must be finite and positive",
  );
  if (
    Number.isInteger(sourceNumerator) &&
    sourceNumerator <= 0xffff_ffff &&
    Number.isInteger(sourceDenominator) &&
    sourceDenominator <= 0xffff_ffff
  ) {
    let divisor = sourceNumerator;
    let remainder = sourceDenominator;
    while (remainder !== 0) {
      const next = divisor % remainder;
      divisor = remainder;
      remainder = next;
    }
    return {
      kind: "rational",
      numerator: sourceNumerator / divisor,
      denominator: sourceDenominator / divisor,
    };
  }
  const numerator = frameTimeFromNumber(sourceNumerator);
  const denominator = frameTimeFromNumber(sourceDenominator);
  let top = BigInt(numerator.significand);
  let bottom = BigInt(denominator.significand);
  const divisor = gcd(top, bottom);
  top /= divisor;
  bottom /= divisor;
  const exponent = numerator.exponent - denominator.exponent;
  if (exponent > 0) top <<= BigInt(exponent);
  else bottom <<= BigInt(-exponent);
  if (top <= 0xffff_ffffn && bottom <= 0xffff_ffffn)
    return { kind: "rational", numerator: Number(top), denominator: Number(bottom) };
  return { kind: "binary_ratio", numerator, denominator };
}

export function validateFrameRate(value: unknown): FrameRate {
  const rate = object(value, ["kind", "numerator", "denominator"]);
  if (rate.kind === "rational") {
    const numerator = integer(rate.numerator, 1, 0xffff_ffff);
    const denominator = integer(rate.denominator, 1, 0xffff_ffff);
    requirePlan(
      gcd(BigInt(numerator), BigInt(denominator)) === 1n,
      "invalid_rational",
      "Frame rate must be reduced",
    );
    return { kind: "rational", numerator, denominator };
  }
  requirePlan(rate.kind === "binary_ratio", "unknown_variant", "Unknown frame rate variant");
  const numerator = validateFrameTime(rate.numerator);
  const denominator = validateFrameTime(rate.denominator);
  requirePlan(
    numerator.kind === "binary_rational" &&
      denominator.kind === "binary_rational" &&
      !numerator.negative &&
      !denominator.negative &&
      numerator.significand > 0 &&
      denominator.significand > 0,
    "invalid_rational",
    "Binary frame rate scalars must be positive finite binary64 values",
  );
  return { kind: "binary_ratio", numerator, denominator };
}
