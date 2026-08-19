import { createLayerForComposition } from "./layer-factory";
import type { Composition, Layer } from "./types";

const MAX_IMAGE_BYTES = 32 * 1024 * 1024;
const MAX_VIDEO_BYTES = 96 * 1024 * 1024;

export async function importMediaLayer(
  kind: "image" | "video",
  composition: Composition,
  currentTime: number,
): Promise<Layer | undefined> {
  const file = await pickFile(kind === "image" ? "image/*" : "video/*");
  if (!file) return undefined;
  return createMediaLayerFromFile(kind, file, composition, currentTime);
}

export async function createMediaLayerFromFile(
  kind: "image" | "video",
  file: File,
  composition: Composition,
  currentTime: number,
): Promise<Layer> {
  const limit = kind === "image" ? MAX_IMAGE_BYTES : MAX_VIDEO_BYTES;
  if (file.size > limit)
    throw new Error(
      `${kind === "image" ? "Image" : "Video"} exceeds the ${Math.round(limit / 1024 / 1024)} MiB embedded-asset limit`,
    );
  if (!file.type.startsWith(`${kind}/`)) throw new Error(`Selected file is not a valid ${kind}`);
  const dataUrl = await fileToDataUrl(file);
  const metadata: { width: number; height: number; duration?: number } =
    kind === "image" ? await readImageMetadata(file) : await readVideoMetadata(dataUrl);
  const layer = createLayerForComposition(kind, composition, currentTime);
  layer.name = file.name.replace(/\.[^.]+$/, "") || layer.name;
  layer.size = fitInside(metadata.width, metadata.height, composition.width, composition.height);
  layer.asset = {
    name: file.name,
    mimeType: file.type,
    dataUrl,
    ...metadata,
  };
  if (kind === "video" && metadata.duration)
    layer.outPoint = Math.min(composition.duration, currentTime + metadata.duration);
  layer.color = [1, 1, 1, 1];
  return layer;
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
