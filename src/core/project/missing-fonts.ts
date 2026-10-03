import type { Operation } from "../editing/operation-types";
import { fontFamilyNames } from "../layers/text-style";
import type { FontAvailability } from "../media/font-availability";
import type { Project } from "../types";

export interface MissingFontFamily {
  /** The `textStyle.fontFamily` value exactly as text layers store it. */
  readonly family: string;
  readonly layerCount: number;
}

/**
 * Text-style families whose every listed name is unavailable. Such text renders with the
 * renderer's native fallback face; a family list with any available or generic entry already
 * resolves as its author intended.
 */
export function findMissingFontFamilies(
  project: Project,
  isAvailable: FontAvailability,
): MissingFontFamily[] {
  const usage = new Map<string, number>();
  for (const composition of project.compositions)
    for (const layer of composition.layers) {
      const family = layer.textStyle?.fontFamily.trim();
      if (family) usage.set(family, (usage.get(family) ?? 0) + 1);
    }
  const missing: MissingFontFamily[] = [];
  for (const [family, layerCount] of usage) {
    const names = fontFamilyNames(family);
    if (names.length > 0 && !names.some(isAvailable)) missing.push({ family, layerCount });
  }
  return missing.sort(
    (a, b) => b.layerCount - a.layerCount || a.family.localeCompare(b.family, "en"),
  );
}

/**
 * Retargets every text layer using a replaced family, across all compositions, as one
 * transaction. Like footage relinking, substitution is a project-level repair, so locked layers
 * are unlocked for the edit and locked again.
 */
export function fontReplacementOperations(
  project: Project,
  replacements: ReadonlyMap<string, string>,
): Operation[] {
  const operations: Operation[] = [];
  let active = project.activeCompositionId;
  for (const composition of project.compositions)
    for (const layer of composition.layers) {
      const style = layer.textStyle;
      const replacement = style && replacements.get(style.fontFamily.trim())?.trim();
      if (!style || !replacement || replacement === style.fontFamily) continue;
      if (active !== composition.id) {
        operations.push({ type: "setActiveComposition", compositionId: composition.id });
        active = composition.id;
      }
      if (layer.locked)
        operations.push({ type: "toggleLayer", layerId: layer.id, field: "locked" });
      operations.push({
        type: "setTextStyle",
        layerId: layer.id,
        textStyle: { ...style, fontFamily: replacement },
      });
      if (layer.locked)
        operations.push({ type: "toggleLayer", layerId: layer.id, field: "locked" });
    }
  if (active !== project.activeCompositionId)
    operations.push({ type: "setActiveComposition", compositionId: project.activeCompositionId });
  return operations;
}
