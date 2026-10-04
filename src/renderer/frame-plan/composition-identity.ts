import { integer, object, requirePlan, validUnicode } from "./canonical";
import type { CompositionIdentity } from "./types";

/** Keeps ordinary identities as strings and preserves otherwise non-UTF-8 JS code units. */
export function compositionIdentityFromString(value: string): CompositionIdentity {
  requirePlan(
    typeof value === "string" && value.length > 0,
    "invalid_json",
    "Composition identity must be nonempty",
  );
  if (validUnicode(value)) return value;
  const utf16_units = [];
  for (let index = 0; index < value.length; index++) utf16_units.push(value.charCodeAt(index));
  return { utf16_units };
}

export function compositionIdentityToString(value: unknown): string {
  if (typeof value === "string") {
    requirePlan(
      value.length > 0 && validUnicode(value),
      "invalid_json",
      "String composition identity must be nonempty valid Unicode",
    );
    return value;
  }
  const identity = object(value, ["utf16_units"]);
  const units = identity.utf16_units;
  requirePlan(
    Array.isArray(units) && units.length > 0,
    "invalid_json",
    "UTF-16 composition identity must contain code units",
  );
  let result = "";
  for (let start = 0; start < units.length; start += 8192) {
    const chunk = Array.from({ length: Math.min(8192, units.length - start) }, (_, offset) =>
      integer(units[start + offset], 0, 0xffff),
    );
    result += String.fromCharCode(...chunk);
  }
  requirePlan(
    !validUnicode(result),
    "invalid_json",
    "Valid Unicode composition identities must use the string representation",
  );
  return result;
}
