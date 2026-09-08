import { activateProjectFonts, prepareProjectFonts } from "../core/media/project-font-runtime";
import { projectFontMetadata } from "../core/project/project-fonts";
import type { Project } from "../core/types";
import { listSystemFonts } from "../desktop/fonts";
import { checkFontAvailability } from "./font-availability";

export async function listFonts(project: Project, input: Record<string, unknown>) {
  const source = input.source ?? "all";
  const query = String(input.query ?? "").toLowerCase();
  const system =
    source === "project"
      ? []
      : (await listSystemFonts()).map((font) => ({ ...font, source: "system" as const }));
  const embedded =
    source === "system"
      ? []
      : (project.fonts ?? []).map((font) => ({
          ...projectFontMetadata(font),
          source: "project" as const,
        }));
  const fonts = [...system, ...embedded]
    .filter((font) =>
      Object.values(font).some((value) => String(value).toLowerCase().includes(query)),
    )
    .sort(
      (a, b) =>
        a.family.localeCompare(b.family) || JSON.stringify(a).localeCompare(JSON.stringify(b)),
    );
  const offset = Number(input.offset ?? 0);
  const limit = Number(input.limit ?? 64);
  return {
    total: fonts.length,
    offset,
    fonts: fonts.slice(offset, offset + limit),
    nextOffset: offset + limit < fonts.length ? offset + limit : null,
  };
}

export async function checkFonts(project: Project, families: string[]) {
  await prepareProjectFonts(project);
  activateProjectFonts(project);
  await document.fonts.ready;
  let installed: Set<string> | undefined;
  let limitation: string | undefined;
  try {
    installed = new Set((await listSystemFonts()).map((font) => font.family.toLowerCase()));
  } catch {
    limitation = "System inventory is unavailable; fallback-metrics results are heuristic.";
  }
  const fonts = families.map((family) => {
    const key = family.toLowerCase();
    if (project.fonts?.some((font) => font.family.toLowerCase() === key))
      return { family, available: true, method: "project-font" };
    if (["serif", "sans-serif", "monospace", "system-ui", "cursive", "fantasy"].includes(key))
      return { family, available: true, method: "generic-family" };
    return installed
      ? { family, available: installed.has(key), method: "system-inventory" }
      : checkFontAvailability(family);
  });
  return { fonts, ...(limitation ? { limitation } : {}) };
}
