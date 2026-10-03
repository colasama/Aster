import { listSystemFonts } from "../../desktop/fonts";
import { isGenericFontFamily } from "../layers/text-style";
import type { Project } from "../types";

/** Detect native fallback by comparing multiple generic faces. This is not a font-file inventory. */
export function checkFontAvailability(family: string) {
  if (["serif", "sans-serif", "monospace", "system-ui", "cursive", "fantasy"].includes(family))
    return { family, available: true, method: "generic-family" };
  const context = document.createElement("canvas").getContext("2d");
  if (!context) throw new Error("Font measurement is unavailable");
  const sample = "mmmmWWWWii0123456789汉字";
  const available = ["serif", "sans-serif", "monospace"].some((fallback) => {
    context.font = `72px ${fallback}`;
    const baseline = context.measureText(sample).width;
    context.font = `72px ${JSON.stringify(family)}, ${fallback}`;
    return Math.abs(context.measureText(sample).width - baseline) > 0.01;
  });
  return { family, available, method: "fallback-metrics" };
}

export type FontAvailability = (family: string) => boolean;

/**
 * Resolves whether a single family name renders as itself. Embedded project fonts and the system
 * inventory answer first; fallback metrics cover localized and alias names (for example 微软雅黑)
 * that the inventory reports under another name, and runtimes without an inventory.
 */
export async function resolveFontAvailability(project: Project): Promise<FontAvailability> {
  const embedded = new Set((project.fonts ?? []).map((font) => font.family.toLowerCase()));
  let installed: ReadonlySet<string> = new Set();
  try {
    installed = new Set((await listSystemFonts()).map((font) => font.family.toLowerCase()));
  } catch {
    // Fallback metrics alone still detect missing families.
  }
  const measured = new Map<string, boolean>();
  return (family) => {
    const key = family.trim().toLowerCase();
    if (!key || isGenericFontFamily(key) || embedded.has(key) || installed.has(key)) return true;
    let available = measured.get(key);
    if (available === undefined) {
      try {
        available = checkFontAvailability(family.trim()).available;
      } catch {
        available = true;
      }
      measured.set(key, available);
    }
    return available;
  };
}
