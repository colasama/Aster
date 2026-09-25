import { convertFileSrc, isDesktopRuntime, open } from "../../desktop/api";
import { mediaImportRuntime } from "../../importers/media-import-runtime";
import { readRasterImageMetadata } from "../../importers/raster-image-decoder";
import { warmRasterImage } from "../../importers/raster-image-prefetch";
import { createLayerForComposition } from "../layers/layer-factory";
import {
  type Composition,
  createId,
  type FootageSource,
  type Layer,
  setLayerSizeAndCenterAnchor,
} from "../types";
import { DEFAULT_SOURCE_INTERPRETATION, sourceLocator } from "./footage-source";
import { ImporterRegistry, type SourceImporter } from "./importer-registry";

const MAX_IMAGE_BYTES = 32 * 1024 * 1024;
const MAX_VIDEO_BYTES = 96 * 1024 * 1024;
const MAX_AUDIO_BYTES = 96 * 1024 * 1024;
const AUDIO_EXTENSION = /\.(wav|mp3|aac|m4a|ogg|flac)$/i;

export type ImportMediaKind = "image" | "video" | "audio";

export interface ImportedMediaLayer {
  source: FootageSource;
  layer: Layer;
}

export interface MediaImportFileOptions {
  runtimeUrl?: string;
  sourcePath?: string;
}

export const mediaImporterRegistry = new ImporterRegistry();
mediaImporterRegistry.register(createStillImporter());
mediaImporterRegistry.register(createVideoImporter());
mediaImporterRegistry.register(createAudioImporter());

export async function importMediaLayer(
  kind: ImportMediaKind,
  composition: Composition,
  currentTime: number,
): Promise<ImportedMediaLayer | undefined> {
  const picked = isDesktopRuntime()
    ? await pickDesktopFile(kind)
    : await pickBrowserFile(
        kind === "image"
          ? "image/*"
          : kind === "video"
            ? "video/*"
            : "audio/wav,audio/mpeg,audio/aac,audio/mp4,audio/ogg,audio/flac,.wav,.mp3,.aac,.m4a,.ogg,.flac",
      );
  if (!picked) return undefined;
  return createMediaLayerFromFile(kind, picked.file, composition, currentTime, picked.options);
}

export async function createMediaLayerFromFile(
  kind: ImportMediaKind,
  file: File,
  composition: Composition,
  currentTime: number,
  options: MediaImportFileOptions = {},
): Promise<ImportedMediaLayer> {
  const source = await mediaImporterRegistry.import(
    file,
    { composition, currentTime, mediaOptions: options },
    kind === "image" ? "aster.still" : kind === "video" ? "aster.video" : "aster.audio",
  );
  if (
    (options.runtimeUrl || options.sourcePath) &&
    (source.kind === "still" || source.kind === "video" || source.kind === "audio")
  )
    mediaImportRuntime.register(source.id, {
      kind: source.kind,
      ...(options.sourcePath ? { originalPath: options.sourcePath } : {}),
    });
  // Overlap the decode with import bookkeeping so the first present can land on a warm bitmap.
  if (source.kind === "still")
    warmRasterImage(sourceLocator(source), { name: source.name, mimeType: source.mimeType });
  const layer = createMediaLayerForSource(source, composition, currentTime);
  layer.name = file.name.replace(/\.[^.]+$/, "") || layer.name;
  return { source, layer };
}

export function createMediaLayerForSource(
  source: FootageSource,
  composition: Composition,
  currentTime: number,
): Layer {
  const kind = source.kind === "audio" ? "audio" : source.kind === "video" ? "video" : "image";
  const layer = createLayerForComposition(kind, composition, currentTime);
  layer.name = source.name.replace(/\.[^.]+$/, "") || layer.name;
  layer.sourceId = source.id;
  if ("width" in source && "height" in source)
    setLayerSizeAndCenterAnchor(
      layer,
      fitInside(source.width, source.height, composition.width, composition.height),
    );
  if (source.kind === "video" || source.kind === "audio")
    layer.outPoint = Math.min(composition.duration, currentTime + source.duration);
  layer.color = [1, 1, 1, 1];
  return layer;
}

function createStillImporter(): SourceImporter {
  return {
    id: "aster.still",
    probe: (file) => (file.type.startsWith("image/") && file.type !== "image/svg+xml" ? 1 : 0),
    validate: (file) => validateFile(file, "image", MAX_IMAGE_BYTES),
    import: async (file, context) => {
      const options = mediaOptions(context);
      const [locator, bytes, metadata] = await Promise.all([
        options.runtimeUrl ? Promise.resolve(options.runtimeUrl) : fileToDataUrl(file),
        file.arrayBuffer(),
        readImageMetadata(file),
      ]);
      return {
        id: createId(),
        kind: "still",
        name: file.name,
        mimeType: file.type,
        contentIdentity: await sha256Identity(bytes),
        ...(options.runtimeUrl ? { runtimeUrl: locator } : { dataUrl: locator }),
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
    import: async (file, context) => {
      const options = mediaOptions(context);
      const [locator, bytes] = await Promise.all([
        options.runtimeUrl ? Promise.resolve(options.runtimeUrl) : fileToDataUrl(file),
        file.arrayBuffer(),
      ]);
      const metadata = await readVideoMetadata(locator);
      const contentIdentity = await sha256Identity(bytes);
      const audio = await tryDecodeAudioMetadata(bytes);
      return {
        id: createId(),
        kind: "video",
        name: file.name,
        mimeType: file.type,
        contentIdentity,
        ...(options.runtimeUrl ? { runtimeUrl: locator } : { dataUrl: locator }),
        ...metadata,
        ...(audio ? { audio: { ...audio, streamIndex: 0 } } : {}),
        interpretation: { ...DEFAULT_SOURCE_INTERPRETATION },
      };
    },
  };
}

function createAudioImporter(): SourceImporter {
  return {
    id: "aster.audio",
    probe: (file) => (file.type.startsWith("audio/") || AUDIO_EXTENSION.test(file.name) ? 1 : 0),
    validate: (file) => {
      if (!AUDIO_EXTENSION.test(file.name))
        throw new Error("Audio import supports WAV, MP3, AAC, M4A, OGG, and FLAC files");
      if (file.size > MAX_AUDIO_BYTES)
        throw new Error("Audio exceeds the 96 MiB embedded-asset limit");
      if (file.type && !file.type.startsWith("audio/") && file.type !== "video/mp4")
        throw new Error("Selected file is not a valid audio file");
    },
    import: async (file, context) => {
      const options = mediaOptions(context);
      const [locator, bytes] = await Promise.all([
        options.runtimeUrl ? Promise.resolve(options.runtimeUrl) : fileToDataUrl(file),
        file.arrayBuffer(),
      ]);
      const contentIdentity = await sha256Identity(bytes);
      const metadata = await decodeAudioMetadata(bytes, file.name);
      return {
        id: createId(),
        kind: "audio",
        name: file.name,
        mimeType: file.type || audioMimeType(file.name),
        contentIdentity,
        ...(options.runtimeUrl ? { runtimeUrl: locator } : { dataUrl: locator }),
        ...metadata,
        streamIndex: 0,
        interpretation: { ...DEFAULT_SOURCE_INTERPRETATION },
      };
    },
  };
}

function validateFile(file: File, kind: ImportMediaKind, limit: number): void {
  if (file.size > limit)
    throw new Error(
      `${kind === "image" ? "Image" : kind === "video" ? "Video" : "Audio"} exceeds the ${Math.round(limit / 1024 / 1024)} MiB embedded-asset limit`,
    );
  if (file.type && !file.type.startsWith(`${kind}/`))
    throw new Error(`Selected file is not a valid ${kind}`);
}

async function decodeAudioMetadata(
  bytes: ArrayBuffer,
  name: string,
): Promise<{ duration: number; channels: number; sampleRate: number }> {
  const Context = globalThis.AudioContext;
  if (!Context)
    throw new Error("Audio decoding is unavailable in this browser; use the native importer");
  const context = new Context({ latencyHint: "playback" });
  try {
    const buffer = await context.decodeAudioData(bytes);
    if (
      !Number.isFinite(buffer.duration) ||
      buffer.duration <= 0 ||
      buffer.duration > 86_400 ||
      buffer.numberOfChannels < 1 ||
      buffer.numberOfChannels > 32 ||
      buffer.sampleRate < 8_000 ||
      buffer.sampleRate > 384_000
    )
      throw new Error("Decoded audio metadata exceeds supported bounds");
    return {
      duration: buffer.duration,
      channels: buffer.numberOfChannels,
      sampleRate: buffer.sampleRate,
    };
  } catch (error) {
    const failure = new Error(
      `This browser cannot decode ${name}; verify the codec or use Aster's native importer`,
    );
    (failure as Error & { cause?: unknown }).cause = error;
    throw failure;
  } finally {
    await context.close();
  }
}

async function tryDecodeAudioMetadata(
  bytes: ArrayBuffer,
): Promise<{ channels: number; sampleRate: number } | undefined> {
  try {
    const { channels, sampleRate } = await decodeAudioMetadata(bytes, "the video's audio stream");
    return { channels, sampleRate };
  } catch {
    return undefined;
  }
}

function audioMimeType(name: string): string {
  const extension = name.split(".").pop()?.toLowerCase();
  return (
    {
      wav: "audio/wav",
      mp3: "audio/mpeg",
      aac: "audio/aac",
      m4a: "audio/mp4",
      ogg: "audio/ogg",
      flac: "audio/flac",
    }[extension ?? ""] ?? "application/octet-stream"
  );
}

async function sha256Identity(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return `sha256:${Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("")}`;
}

function pickBrowserFile(
  accept: string,
): Promise<{ file: File; options: MediaImportFileOptions } | undefined> {
  const picker = document.createElement("input");
  picker.type = "file";
  picker.accept = accept;
  return new Promise((resolve) => {
    picker.addEventListener(
      "change",
      () => {
        const file = picker.files?.[0];
        resolve(file ? { file, options: {} } : undefined);
      },
      { once: true },
    );
    picker.click();
  });
}

async function pickDesktopFile(
  kind: ImportMediaKind,
): Promise<{ file: File; options: MediaImportFileOptions } | undefined> {
  const selected = await open({
    title:
      kind === "image"
        ? "Choose image asset"
        : kind === "video"
          ? "Choose video asset"
          : "Choose audio asset",
    filters: [
      {
        name: kind === "image" ? "Images" : kind === "video" ? "Videos" : "Audio",
        extensions:
          kind === "image"
            ? ["png", "jpg", "jpeg", "webp", "avif", "gif", "bmp", "tif", "tiff"]
            : kind === "video"
              ? ["mp4", "webm", "mov", "m4v", "ogv", "mkv", "avi"]
              : ["wav", "mp3", "aac", "m4a", "ogg", "flac"],
      },
    ],
  });
  if (typeof selected !== "string") return undefined;
  const runtimeUrl = convertFileSrc(selected);
  const response = await fetch(runtimeUrl);
  if (!response.ok) throw new Error(`Media request failed with HTTP ${response.status}`);
  const blob = await response.blob();
  const name = selected.split(/[\\/]/).pop() || "Imported media";
  const file = new File([blob], name, { type: blob.type || mediaMimeType(name, kind) });
  return { file, options: { runtimeUrl, sourcePath: selected } };
}

function mediaOptions(context: { mediaOptions?: MediaImportFileOptions }): MediaImportFileOptions {
  const options = context.mediaOptions;
  return options ?? {};
}

function mediaMimeType(name: string, kind: ImportMediaKind): string {
  const extension = name.split(".").pop()?.toLowerCase() ?? "";
  if (kind === "audio") return audioMimeType(name);
  if (kind === "image")
    return extension === "jpg" || extension === "jpeg"
      ? "image/jpeg"
      : extension === "svg"
        ? "image/svg+xml"
        : `image/${extension || "png"}`;
  return (
    {
      mp4: "video/mp4",
      m4v: "video/mp4",
      mov: "video/quicktime",
      webm: "video/webm",
      ogv: "video/ogg",
    }[extension] ?? "video/mp4"
  );
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
  return readRasterImageMetadata(file, { name: file.name, mimeType: file.type });
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
