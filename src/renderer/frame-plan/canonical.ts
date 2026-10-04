import { FramePlanError } from "./types";

export function requirePlan(condition: unknown, code: string, message: string): asserts condition {
  if (!condition) throw new FramePlanError(code, message);
}

export function validUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(++index);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
    } else if (code >= 0xdc00 && code <= 0xdfff) return false;
  }
  return true;
}

/** Closed wire objects have ASCII keys; numeric GPU values are carried as binary bytes. */
export function canonicalJson(value: unknown): string {
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
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
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
      return `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`;
    })
    .join(",")}}`;
}

export function integer(value: unknown, minimum = 0, maximum = Number.MAX_SAFE_INTEGER): number {
  requirePlan(
    typeof value === "number" &&
      Number.isSafeInteger(value) &&
      !Object.is(value, -0) &&
      value >= minimum &&
      value <= maximum,
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
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  requirePlan(
    actual.length === expected.length && actual.every((key, index) => key === expected[index]),
    "unknown_field",
    `Expected exactly these fields: ${keys.join(", ")}`,
  );
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
