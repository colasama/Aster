import { readdir, stat } from "node:fs/promises";
import { basename, dirname, extname, resolve } from "node:path";
import { detectImageSequence } from "../src/importers/image-sequence.js";

export interface DesktopImageSequenceFile {
  path: string;
  name: string;
  size: number;
  lastModified: number;
  type: string;
}

const MAX_DIRECTORY_ENTRIES = 100_000;
const IMAGE_MIME: Readonly<Record<string, string>> = {
  ".avif": "image/avif",
  ".bmp": "image/bmp",
  ".gif": "image/gif",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".tif": "image/tiff",
  ".tiff": "image/tiff",
  ".webp": "image/webp",
};

/** Discovers only numbered image siblings in the explicitly selected file's directory. */
export async function discoverDesktopImageSequence(
  selectedPath: string,
): Promise<DesktopImageSequenceFile[]> {
  const selected = resolve(selectedPath);
  const selectedExtension = extname(selected).toLocaleLowerCase();
  if (!IMAGE_MIME[selectedExtension])
    throw new Error("Selected file is not a supported image frame");
  const directory = dirname(selected);
  const entries = await readdir(directory, { withFileTypes: true });
  if (entries.length > MAX_DIRECTORY_ENTRIES)
    throw new Error("Image sequence directory exceeds 100000 entries");
  const candidates = await Promise.all(
    entries.flatMap((entry) => {
      if (!entry.isFile() || !IMAGE_MIME[extname(entry.name).toLocaleLowerCase()]) return [];
      const path = resolve(directory, entry.name);
      return [
        stat(path).then(
          (metadata) =>
            ({
              path,
              name: entry.name,
              size: metadata.size,
              lastModified: Math.floor(metadata.mtimeMs),
              type: IMAGE_MIME[extname(entry.name).toLocaleLowerCase()] as string,
            }) satisfies DesktopImageSequenceFile,
        ),
      ];
    }),
  );
  const selection = detectImageSequence(candidates, basename(selected));
  return selection.frames.map((frame) => frame.file);
}
