import type { Layer, TextStyle } from "../types";

export function resolveTextStyle(layer: Pick<Layer, "name" | "size" | "textStyle">): TextStyle {
  const hero = layer.name === "ASTER";
  return (
    layer.textStyle ?? {
      fontFamily: 'Inter, "Segoe UI", sans-serif',
      fontSize: layer.size[1] * (hero ? 0.82 : 0.56),
      fontWeight: hero ? 800 : 600,
      alignment: "center",
      tracking: layer.size[1] * (hero ? 0.15 : 0.34),
      leading: layer.size[1] * 0.72,
      strokeWidth: 0,
      strokeColor: [0, 0, 0, 1],
    }
  );
}

const GENERIC_FONT_FAMILIES = new Set([
  "serif",
  "sans-serif",
  "monospace",
  "cursive",
  "fantasy",
  "system-ui",
  "ui-serif",
  "ui-sans-serif",
  "ui-monospace",
  "ui-rounded",
  "emoji",
  "math",
]);

export function isGenericFontFamily(family: string): boolean {
  return GENERIC_FONT_FAMILIES.has(family.trim().toLowerCase());
}

/** Splits a CSS font-family value into unquoted family names. */
export function fontFamilyNames(value: string): string[] {
  const names: string[] = [];
  let current = "";
  let quote: string | undefined;
  for (const character of value) {
    if (quote) {
      if (character === quote) quote = undefined;
      else current += character;
    } else if (character === '"' || character === "'") quote = character;
    else if (character === ",") {
      names.push(current);
      current = "";
    } else current += character;
  }
  names.push(current);
  return names.map((name) => name.trim().replace(/\s+/gu, " ")).filter(Boolean);
}

/**
 * CSS font-family token for canvas font shorthands. A plain family name is always quoted, so
 * names with digits, spaces or punctuation (for example `Brand 400W`) resolve exactly as
 * `check_fonts` reports them. Quoted names, family lists and generic families pass through.
 */
export function cssFontFamily(family: string): string {
  const trimmed = family.trim();
  if (!trimmed || /["',]/u.test(trimmed) || GENERIC_FONT_FAMILIES.has(trimmed.toLowerCase()))
    return trimmed || "sans-serif";
  return JSON.stringify(trimmed);
}
