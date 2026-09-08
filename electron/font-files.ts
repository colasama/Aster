import { randomUUID } from "node:crypto";
import { open } from "node:fs/promises";
import { basename, extname, isAbsolute } from "node:path";
import { fontWeightRange } from "../src/core/media/font-weight-range.js";
import {
  MAX_PROJECT_FONT_BYTES,
  type ProjectFont,
  validateProjectFonts,
} from "../src/core/project/project-fonts.js";

export async function readProjectFont(
  path: unknown,
  family: unknown,
  weight: unknown = 400,
  weightRange?: unknown,
): Promise<ProjectFont> {
  if (typeof path !== "string" || !isAbsolute(path))
    throw new Error("Use an absolute font file path");
  const format = extname(path).slice(1).toLowerCase();
  if (!["ttf", "otf", "woff", "woff2"].includes(format))
    throw new Error("Import a TTF, OTF, WOFF or WOFF2 font face");
  const file = await open(path, "r");
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size < 4 || info.size > MAX_PROJECT_FONT_BYTES)
      throw new Error("Font must be a nonempty file of at most 8 MiB");
    const data = Buffer.alloc(info.size + 1);
    let length = 0;
    while (length < data.length) {
      const read = await file.read(data, length, data.length - length, null);
      if (!read.bytesRead) break;
      length += read.bytesRead;
    }
    if (length !== info.size) throw new Error("Font file changed while reading");
    const magic = data.subarray(0, 4).toString("latin1");
    const signatures: Record<string, string[]> = {
      ttf: ["\0\x01\0\0", "true"],
      otf: ["OTTO"],
      woff: ["wOFF"],
      woff2: ["wOF2"],
    };
    if (!signatures[format].includes(magic))
      throw new Error("Font signature does not match its extension");
    const font = {
      id: randomUUID(),
      name: basename(path).slice(0, 160),
      family,
      weight,
      weightRange: weightRange ?? fontWeightRange(data.subarray(0, length)),
      dataUrl: `data:font/${format};base64,${data.subarray(0, length).toString("base64")}`,
    };
    validateProjectFonts([font]);
    return font as ProjectFont;
  } finally {
    await file.close();
  }
}
