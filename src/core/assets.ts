import { DEFAULT_SOURCE_INTERPRETATION } from "./footage-source";
import { ImporterRegistry, type SourceImporter } from "./importer-registry";
import { createLayerForComposition } from "./layer-factory";
import type { Composition, FootageSource, Layer } from "./types";
import { createId } from "./types";

const MAX_IMAGE_BYTES = 32 * 1024 * 1024;
const MAX_VIDEO_BYTES = 96 * 1024 * 1024;

export interface ImportedMediaLayer {
  source: FootageSource;
  layer: Layer;
}

export const mediaImporterRegistry = new ImporterRegistry();
mediaImporterRegistry.register(createStillImporter());
mediaImporterRegistry.register(createVideoImporter());

export async function importMediaLayer(
  kind: "image" | "video",
  composition: Composition,
  currentTime: number,
): Promise<ImportedMediaLayer | undefined> {
  const file = await pickFile(kind === "image" ? "image/*" : "video/*");
  if (!file) return undefined;
  return createMediaLayerFromFile(kind, file, composition, currentTime);
}

export async function createMediaLayerFromFile(
  kind: "image" | "video",
  file: File,
  composition: Composition,
  currentTime: number,
): Promise<ImportedMediaLayer> {
  const source = await mediaImporterRegistry.import(
    file,
    { composition, currentTime },
    kind === "image" ? "aster.still" : "aster.video",
  );
  const layer = createLayerForComposition(kind, composition, currentTime);
  layer.name = file.name.replace(/\.[^.]+$/, "") || layer.name;
  layer.sourceId = source.id;
  if ("width" in source && "height" in source)
    layer.size = fitInside(source.width, source.height, composition.width, composition.height);
  if (source.kind === "video")
    layer.outPoint = Math.min(composition.duration, currentTime + source.duration);
  layer.color = [1, 1, 1, 1];
  return { source, layer };
}

function createStillImporter(): SourceImporter {
  return {
    id: "aster.still",
    probe: (file) => (file.type.startsWith("image/") && file.type !== "image/svg+xml" ? 1 : 0),
    validate: (file) => validateFile(file, "image", MAX_IMAGE_BYTES),
    import: async (file) => {
      const [dataUrl, bytes, metadata] = await Promise.all([
        fileToDataUrl(file),
        file.arrayBuffer(),
        readImageMetadata(file),
      ]);
      return {
        id: createId(),
        kind: "still",
        name: file.name,
        mimeType: file.type,
        contentIdentity: await sha256Identity(bytes),
        dataUrl,
        ...metadata,
        interpretation: { ...DEFAULT_SOURCE_INTERPRETATION },
      };
    },
  };
}

function createVideoImporter(): SourceImporter {
  return {
    id: "aster.video",
    probe: (file) => (file.type.startsWith("video/") ? 1 : 0),
    validate: (file) => validateFile(file, "video", MAX_VIDEO_BYTES),
    import: async (file) => {
      const [dataUrl, bytes] = await Promise.all([fileToDataUrl(file), file.arrayBuffer()]);
      const metadata = await readVideoMetadata(dataUrl);
      return {
        id: createId(),
        kind: "video",
        name: file.name,
        mimeType: file.type,
        contentIdentity: await sha256Identity(bytes),
        dataUrl,
        ...metadata,
        interpretation: { ...DEFAULT_SOURCE_INTERPRETATION },
      };
    },
  };
}

function validateFile(file: File, kind: "image" | "video", limit: number): void {
  if (file.size > limit)
    throw new Error(
      `${kind === "image" ? "Image" : "Video"} exceeds the ${Math.round(limit / 1024 / 1024)} MiB embedded-asset limit`,
    );
  if (!file.type.startsWith(`${kind}/`)) throw new Error(`Selected file is not a valid ${kind}`);
}

async function sha256Identity(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return `sha256:${Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("")}`;
}

function pickFile(accept: string): Promise<File | undefined> {
  const picker = document.createElement("input");
  picker.type = "file";
  picker.accept = accept;
  return new Promise((resolve) => {
    picker.addEventListener("change", () => resolve(picker.files?.[0]), { once: true });
    picker.click();
  });
}

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => resolve(String(reader.result)), { once: true });
    reader.addEventListener("error", () => reject(reader.error ?? new Error("Asset read failed")), {
      once: true,
    });
    reader.readAsDataURL(file);
  });
}

async function readImageMetadata(file: File): Promise<{ width: number; height: number }> {
  const bitmap = await createImageBitmap(file);
  const metadata = { width: bitmap.width, height: bitmap.height };
  bitmap.close();
  return metadata;
}

function readVideoMetadata(
  dataUrl: string,
): Promise<{ width: number; height: number; duration: number }> {
  return new Promise((resolve, reject) => {
    const video = document.createElement("video");
    video.preload = "metadata";
    video.addEventListener(
      "loadedmetadata",
      () =>
        resolve({ width: video.videoWidth, height: video.videoHeight, duration: video.duration }),
      { once: true },
    );
    video.addEventListener("error", () => reject(new Error("Unable to read video metadata")), {
      once: true,
    });
    video.src = dataUrl;
  });
}

function fitInside(
  width: number,
  height: number,
  maxWidth: number,
  maxHeight: number,
): [number, number] {
  const scale = Math.min(1, maxWidth / width, maxHeight / height);
  return [Math.max(1, Math.round(width * scale)), Math.max(1, Math.round(height * scale))];
}
