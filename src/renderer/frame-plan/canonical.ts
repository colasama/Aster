import { FramePlanError } from "./types";

export { copyWireValue } from "../../core/rendering/wire-copy";

export function requirePlan(condition: unknown, code: string, message: string): asserts condition {
  if (!condition) throw new FramePlanError(code, message);
}

export function validUnicode(value: string): boolean {
  // Prefer the native scalar scan; retain identical validation on older web runtimes.
  const text = value as string & { isWellFormed?: () => boolean };
  return text.isWellFormed?.() ?? !/[\uD800-\uDFFF]/u.test(value);
}

/** Compare a candidate with owned, already validated JSON without serializing large strings. */
export function sameCanonicalValue(candidate: unknown, verified: unknown): boolean {
  if (Object.is(candidate, verified)) return true;
  if (!candidate || !verified || typeof candidate !== "object" || typeof verified !== "object")
    return false;
  if (Array.isArray(candidate) || Array.isArray(verified))
    return (
      Array.isArray(candidate) &&
      Array.isArray(verified) &&
      candidate.length === verified.length &&
      Array.from(candidate).every((value, index) => sameCanonicalValue(value, verified[index]))
    );
  if (![Object.prototype, null].includes(Object.getPrototypeOf(candidate))) return false;
  const keys = Object.keys(candidate);
  const expectedKeys = Object.keys(verified);
  return (
    keys.length === expectedKeys.length &&
    keys.every(
      (key) =>
        expectedKeys.includes(key) &&
        sameCanonicalValue(
          (candidate as Record<string, unknown>)[key],
          (verified as Record<string, unknown>)[key],
        ),
    )
  );
}

/** Validate and order an owned tree before native JSON serialization. */
export function canonicalJson(value: unknown): string {
  if (typeof value !== "object" || value === null) return canonicalJsonTokens(value);
  const state = { tokens: false };
  const prepared = prepareCanonical(value, state);
  // Native JSON orders integer keys numerically and fills sparse arrays with null. Keep
  // lexicographic keys and the existing sparse-array behavior on these uncommon inputs.
  return state.tokens ? canonicalJsonTokens(prepared) : JSON.stringify(prepared);
}

function prepareCanonical(value: unknown, state: { tokens: boolean }): unknown {
  if (typeof value === "string") {
    requirePlan(validUnicode(value), "invalid_utf8", "Unpaired UTF-16 surrogate");
    return value;
  }
  if (typeof value === "number") {
    requirePlan(
      Number.isSafeInteger(value) && !Object.is(value, -0),
      "invalid_safe_integer",
      "Metadata numbers must be safe integers without negative zero",
    );
    return value;
  }
  if (typeof value === "boolean" || value === null) return value;
  if (Array.isArray(value)) {
    let count = 0;
    const result = value.map((entry) => {
      count++;
      return prepareCanonical(entry, state);
    });
    state.tokens ||= count !== value.length;
    return result;
  }
  requirePlan(
    value !== null &&
      typeof value === "object" &&
      [Object.prototype, null].includes(Object.getPrototypeOf(value)),
    "invalid_json",
    "Metadata must contain only plain JSON values",
  );
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    requirePlan(/^[\x20-\x7e]+$/.test(key), "unknown_field", "Wire keys must be ASCII");
    state.tokens ||= /^[0-9]/.test(key);
    const entry = prepareCanonical((value as Record<string, unknown>)[key], state);
    if (key === "__proto__") Object.defineProperty(result, key, { value: entry, enumerable: true });
    else result[key] = entry;
  }
  return result;
}

/** Closed wire objects have ASCII keys; numeric GPU values are carried as binary bytes. */
function canonicalJsonTokens(value: unknown): string {
  if (typeof value === "string") {
    requirePlan(validUnicode(value), "invalid_utf8", "Unpaired UTF-16 surrogate");
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    requirePlan(
      Number.isSafeInteger(value) && !Object.is(value, -0),
      "invalid_safe_integer",
      "Metadata numbers must be safe integers without negative zero",
    );
    return String(value);
  }
  if (typeof value === "boolean" || value === null) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJsonTokens).join(",")}]`;
  requirePlan(
    value !== null &&
      typeof value === "object" &&
      [Object.prototype, null].includes(Object.getPrototypeOf(value)),
    "invalid_json",
    "Metadata must contain only plain JSON values",
  );
  return `{${Object.keys(value)
    .sort()
    .map((key) => {
      requirePlan(/^[\x20-\x7e]+$/.test(key), "unknown_field", "Wire keys must be ASCII");
      return `${JSON.stringify(key)}:${canonicalJsonTokens((value as Record<string, unknown>)[key])}`;
    })
    .join(",")}}`;
}

export function integer(value: unknown, minimum = 0, maximum = Number.MAX_SAFE_INTEGER): number {
  if (
    !(
      typeof value === "number" &&
      Number.isSafeInteger(value) &&
      !Object.is(value, -0) &&
      value >= minimum &&
      value <= maximum
    )
  )
    throw new FramePlanError(
      "invalid_safe_integer",
      `Expected an integer in [${minimum}, ${maximum}]`,
    );
  return value;
}

export function object(value: unknown, keys: string[]): Record<string, unknown> {
  requirePlan(
    value !== null && typeof value === "object" && !Array.isArray(value),
    "invalid_json",
    "Expected a wire object",
  );
  const actual = Object.keys(value);
  if (actual.length !== keys.length || actual.some((key) => !keys.includes(key)))
    throw new FramePlanError("unknown_field", `Expected exactly these fields: ${keys.join(", ")}`);
  return value as Record<string, unknown>;
}

export function hash(value: unknown): asserts value is string {
  requirePlan(
    typeof value === "string" && /^[a-f0-9]{64}$/.test(value),
    "hash_mismatch",
    "Expected a lowercase SHA-256 resource hash",
  );
}

export function align16(value: number): number {
  integer(value, 0, 0xffff_fff0);
  return Math.ceil(value / 16) * 16;
}

export function gcd(left: bigint, right: bigint): bigint {
  let a = left < 0n ? -left : left;
  let b = right;
  while (b !== 0n) [a, b] = [b, a % b];
  return a;
}
