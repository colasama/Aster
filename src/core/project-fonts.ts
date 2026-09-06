/** Project-owned font bytes travel with saves and immutable render snapshots. */
export interface ProjectFont {
  id: string;
  name: string;
  family: string;
  weight: number;
  dataUrl: string;
}

export const MAX_PROJECT_FONT_BYTES = 8 * 1024 * 1024;
export const MAX_PROJECT_FONTS = 32;
export const MAX_FONT_DATA_URL = Math.ceil(MAX_PROJECT_FONT_BYTES / 3) * 4 + 64;

export function validateProjectFonts(value: unknown): asserts value is ProjectFont[] | undefined {
  if (value === undefined) return;
  if (!Array.isArray(value) || value.length > MAX_PROJECT_FONTS)
    throw new Error("Project fonts must be an array of at most 32 faces");
  const ids = new Set<string>();
  const faces = new Set<string>();
  let bytes = 0;
  for (const font of value) {
    if (!font || typeof font !== "object") throw new Error("Invalid project font");
    for (const key of ["id", "name", "family"] as const)
      if (typeof font[key] !== "string" || !font[key].trim() || font[key].length > 160)
        throw new Error(`Invalid project font ${key}`);
    if (!Number.isInteger(font.weight) || font.weight < 100 || font.weight > 900)
      throw new Error("Project font weight must be an integer from 100 to 900");
    if (typeof font.dataUrl !== "string" || font.dataUrl.length > MAX_FONT_DATA_URL)
      throw new Error("Project font data exceeds its budget");
    const match = /^data:font\/(ttf|otf|woff|woff2);base64,([A-Za-z0-9+/]+={0,2})$/.exec(
      font.dataUrl,
    );
    if (!match || match[2].length % 4 !== 0) throw new Error("Invalid embedded font data");
    bytes +=
      (match[2].length / 4) * 3 - (match[2].endsWith("==") ? 2 : match[2].endsWith("=") ? 1 : 0);
    const face = `${font.family.toLowerCase()}\0${font.weight}`;
    if (ids.has(font.id) || faces.has(face))
      throw new Error("Duplicate project font id or family/weight");
    ids.add(font.id);
    faces.add(face);
  }
  if (bytes > MAX_PROJECT_FONT_BYTES) throw new Error("Project fonts exceed the 8 MiB budget");
}

export function projectFontMetadata(font: ProjectFont) {
  return { id: font.id, name: font.name, family: font.family, weight: font.weight };
}
