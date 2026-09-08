import {
  MAX_PROJECT_FONT_BYTES,
  type ProjectFont,
  validateProjectFonts,
} from "../project/project-fonts";
import { fontWeightRange } from "./font-weight-range";

export async function createProjectFont(
  file: File,
  family: string,
  weight = 400,
): Promise<ProjectFont> {
  const format = file.name.split(".").pop()?.toLowerCase();
  if (!format || !["ttf", "otf", "woff", "woff2"].includes(format))
    throw new Error("Import a TTF, OTF, WOFF or WOFF2 font face");
  if (!file.size || file.size > MAX_PROJECT_FONT_BYTES)
    throw new Error("Font must be at most 8 MiB");
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("Cannot read font file"));
    reader.readAsDataURL(new Blob([file], { type: `font/${format}` }));
  });
  const weightRange = fontWeightRange(new Uint8Array(await file.arrayBuffer()));
  const font = {
    id: crypto.randomUUID(),
    name: file.name.slice(0, 160),
    family,
    weight,
    dataUrl,
    ...(weightRange ? { weightRange } : {}),
  };
  validateProjectFonts([font]);
  return font;
}
