import { type ProjectFont, validateProjectFonts } from "./project-fonts";
import type { Project } from "./types";

const pending = new WeakMap<ProjectFont[], Promise<FontFace[]>>();
const ready = new WeakMap<ProjectFont[], FontFace[]>();
// Reuse decoded faces across cloned edit/history snapshots; bound the strong cache to 16 MiB.
const faces = new Map<string, { font: ProjectFont; face: Promise<FontFace> }>();
let cachedCharacters = 0;
let active: FontFace[] = [];
let revision = 0;

/** Decode once per immutable font collection, before presentation or export. */
export async function prepareProjectFonts(project: Pick<Project, "fonts">): Promise<void> {
  const fonts = project.fonts;
  if (!fonts?.length || ready.has(fonts)) return;
  let load = pending.get(fonts);
  if (!load) {
    validateProjectFonts(fonts);
    load = Promise.all(fonts.map(loadFace));
    pending.set(fonts, load);
  }
  try {
    ready.set(fonts, await load);
  } catch (error) {
    pending.delete(fonts);
    throw error;
  }
}

function loadFace(font: ProjectFont): Promise<FontFace> {
  const existing = faces.get(font.id);
  if (
    existing &&
    existing.font.dataUrl === font.dataUrl &&
    existing.font.family === font.family &&
    existing.font.weight === font.weight &&
    String(existing.font.weightRange) === String(font.weightRange)
  ) {
    faces.delete(font.id);
    faces.set(font.id, existing);
    return existing.face;
  }
  if (existing) {
    faces.delete(font.id);
    cachedCharacters -= existing.font.dataUrl.length;
  }
  const face = Promise.resolve().then(async () => {
    try {
      const encoded = font.dataUrl.slice(font.dataUrl.indexOf(",") + 1);
      const bytes = Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0));
      return await new FontFace(font.family, bytes, {
        weight: font.weightRange?.join(" ") ?? String(font.weight),
      }).load();
    } catch {
      if (faces.get(font.id)?.face === face) {
        faces.delete(font.id);
        cachedCharacters -= font.dataUrl.length;
      }
      throw new Error(`Cannot decode project font: ${font.name}`);
    }
  });
  faces.set(font.id, { font, face });
  cachedCharacters += font.dataUrl.length;
  while (faces.size > 64 || cachedCharacters > (16 * 1024 * 1024 * 4) / 3) {
    const oldest = faces.entries().next().value;
    if (!oldest) break;
    faces.delete(oldest[0]);
    cachedCharacters -= oldest[1].font.dataUrl.length;
  }
  return face;
}

/** Switch only project-owned faces; never remove other application/web fonts. */
export function activateProjectFonts(project?: Pick<Project, "fonts">): void {
  const next = project?.fonts?.length ? ready.get(project.fonts) : undefined;
  if (project?.fonts?.length && !next) throw new Error("Project fonts have not finished loading");
  if (
    next === active ||
    (!next && active.length === 0) ||
    (next?.length === active.length && next.every((face, index) => face === active[index]))
  )
    return;
  for (const face of active) document.fonts.delete(face);
  active = next ?? [];
  for (const face of active) document.fonts.add(face);
  revision += 1;
}

export function projectFontsReady(project: Pick<Project, "fonts">): boolean {
  return !project.fonts?.length || ready.has(project.fonts);
}

export function projectFontRevision(): number {
  return revision;
}
