import type { FootageSource } from "../core/types";
import type { MissingSequenceFramePolicy } from "./image-sequence-runtime";
import { mediaIdentityByteLength } from "./media-import-identity";
import type { PsdImportMode } from "./psd-composition";

export const MEDIA_IMPORT_SIDECAR_VERSION = 1 as const;
export const MAX_PORTABLE_MEDIA_BYTES = 128 * 1024 * 1024;
export const MAX_PERSISTED_SEQUENCE_FRAMES = 4_096;
export const MAX_NATIVE_PSD_BYTES = 512 * 1024 * 1024;
export const MAX_NATIVE_FOOTAGE_BYTES = 96 * 1024 * 1024;
export const MAX_MEDIA_IMPORT_ENTRIES = 50_000;
const MAX_ID_LENGTH = 512;
const MAX_PATH_LENGTH = 4_096;

export type MediaImportPersistenceMode = "native" | "portable";

export type PersistedMediaStorage =
  | {
      kind: "inline";
      byteIdentity: string;
      data: string;
    }
  | {
      kind: "external";
      externalPath: string;
      byteIdentity?: string;
    }
  | {
      kind: "relative";
      relativePath: string;
      byteIdentity: string;
      /** Native bridge load-only field. It is never written to project.json. */
      resolvedPath?: string;
    };

export interface PersistedSequenceFrame {
  frame: number;
  name: string;
  size: number;
  lastModified: number;
  type: string;
  storage: PersistedMediaStorage;
}

export type PersistedMediaPayload =
  | {
      id: string;
      kind: "still" | "video" | "audio";
      contentIdentity: string;
      mimeType: string;
      extension: string;
      storage: PersistedMediaStorage;
    }
  | {
      id: string;
      kind: "svg";
      contentIdentity: string;
      width: number;
      height: number;
      storage: PersistedMediaStorage;
    }
  | {
      id: string;
      kind: "psd";
      documentIdentity: string;
      storage: PersistedMediaStorage;
    }
  | {
      id: string;
      kind: "imageSequence";
      contentIdentity: string;
      pattern: string;
      prefix: string;
      extension: string;
      padding: number;
      startFrame: number;
      endFrame: number;
      missingFrames: readonly number[];
      frameRate: { numerator: number; denominator: number };
      missingFramePolicy: MissingSequenceFramePolicy;
      loop: boolean;
      frames: readonly PersistedSequenceFrame[];
    };

export type PersistedMediaEntry =
  | {
      sourceId: string;
      kind: "still" | "video" | "audio";
      contentIdentity: string;
      payloadId: string;
    }
  | {
      sourceId: string;
      kind: "svg";
      contentIdentity: string;
      payloadId: string;
    }
  | {
      sourceId: string;
      kind: "psd";
      contentIdentity: string;
      payloadId: string;
      documentIdentity: string;
      importMode: PsdImportMode;
      layerKey: string;
    }
  | {
      sourceId: string;
      kind: "imageSequence";
      contentIdentity: string;
      payloadId: string;
    };

export interface PersistedMediaImports {
  version: typeof MEDIA_IMPORT_SIDECAR_VERSION;
  entries: readonly PersistedMediaEntry[];
  payloads: readonly PersistedMediaPayload[];
}

export interface HydrateMediaImportOptions {
  /** Only documents returned by the native bridge may contain resolved local paths. */
  allowResolvedPaths?: boolean;
}

export function validatePersistedMediaImports(input: unknown): PersistedMediaImports {
  const sidecar = requireRecord(input, "mediaImports");
  if (sidecar.version !== MEDIA_IMPORT_SIDECAR_VERSION)
    throw new Error("mediaImports.version is unsupported");
  const entries = requireBoundedArray(
    sidecar.entries,
    "mediaImports.entries",
    MAX_MEDIA_IMPORT_ENTRIES,
  ).map(decodeEntry);
  const payloads = requireBoundedArray(
    sidecar.payloads,
    "mediaImports.payloads",
    MAX_MEDIA_IMPORT_ENTRIES,
  ).map(decodePayload);
  const entryIds = new Set<string>();
  for (const entry of entries) {
    if (entryIds.has(entry.sourceId))
      throw new Error("mediaImports.entries contains duplicate source ids");
    entryIds.add(entry.sourceId);
  }
  const payloadIds = new Set<string>();
  let inlineBytes = 0;
  for (const payload of payloads) {
    if (payloadIds.has(payload.id)) throw new Error("mediaImports.payloads contains duplicate ids");
    payloadIds.add(payload.id);
    for (const storage of payloadStorages(payload))
      if (storage.kind === "inline") {
        inlineBytes += mediaIdentityByteLength(storage.byteIdentity);
        if (!Number.isSafeInteger(inlineBytes) || inlineBytes > MAX_PORTABLE_MEDIA_BYTES)
          throw new Error("mediaImports inline payloads exceed 128 MiB");
      }
  }
  return { version: MEDIA_IMPORT_SIDECAR_VERSION, entries, payloads };
}

function decodeEntry(value: unknown, index: number): PersistedMediaEntry {
  const path = `mediaImports.entries[${index}]`;
  const entry = requireRecord(value, path);
  const kind = requireKind(entry.kind, `${path}.kind`);
  const base = {
    sourceId: requireId(entry.sourceId, `${path}.sourceId`),
    kind,
    contentIdentity: requireIdentity(entry.contentIdentity, `${path}.contentIdentity`),
    payloadId: requireId(entry.payloadId, `${path}.payloadId`),
  };
  if (kind !== "psd") return base as PersistedMediaEntry;
  const importMode = entry.importMode;
  if (!isPsdImportMode(importMode)) throw new Error(`${path}.importMode is unsupported`);
  return {
    ...base,
    kind,
    documentIdentity: requireIdentity(entry.documentIdentity, `${path}.documentIdentity`),
    importMode,
    layerKey: requireId(entry.layerKey, `${path}.layerKey`),
  };
}

function decodePayload(value: unknown, index: number): PersistedMediaPayload {
  const path = `mediaImports.payloads[${index}]`;
  const payload = requireRecord(value, path);
  const id = requireId(payload.id, `${path}.id`);
  const kind = requireKind(payload.kind, `${path}.kind`);
  if (isFootageKind(kind))
    return {
      id,
      kind,
      contentIdentity: requireIdentity(payload.contentIdentity, `${path}.contentIdentity`),
      mimeType: requireBoundedString(payload.mimeType, `${path}.mimeType`, 256),
      extension: requireMediaExtension(payload.extension, kind, `${path}.extension`),
      storage: decodeStorage(payload.storage, `${path}.storage`),
    };
  if (kind === "svg")
    return {
      id,
      kind,
      contentIdentity: requireIdentity(payload.contentIdentity, `${path}.contentIdentity`),
      width: requireBoundedInteger(payload.width, `${path}.width`, 1, 32_768),
      height: requireBoundedInteger(payload.height, `${path}.height`, 1, 32_768),
      storage: decodeStorage(payload.storage, `${path}.storage`),
    };
  if (kind === "psd")
    return {
      id,
      kind,
      documentIdentity: requireIdentity(payload.documentIdentity, `${path}.documentIdentity`),
      storage: decodeStorage(payload.storage, `${path}.storage`),
    };
  const frames = requireBoundedArray(
    payload.frames,
    `${path}.frames`,
    MAX_PERSISTED_SEQUENCE_FRAMES,
  ).map((frame, frameIndex) => decodeFrame(frame, `${path}.frames[${frameIndex}]`));
  if (frames.length === 0) throw new Error(`${path}.frames must not be empty`);
  const frameNumbers = new Set<number>();
  for (const frame of frames) {
    if (frameNumbers.has(frame.frame)) throw new Error(`${path}.frames contains a duplicate frame`);
    frameNumbers.add(frame.frame);
  }
  const missingFramePolicy = payload.missingFramePolicy;
  if (!isMissingFramePolicy(missingFramePolicy))
    throw new Error(`${path}.missingFramePolicy is unsupported`);
  if (typeof payload.loop !== "boolean") throw new Error(`${path}.loop must be a boolean`);
  const startFrame = requireBoundedInteger(
    payload.startFrame,
    `${path}.startFrame`,
    0,
    1_000_000_000,
  );
  const endFrame = requireBoundedInteger(payload.endFrame, `${path}.endFrame`, 0, 1_000_000_000);
  if (
    endFrame < startFrame ||
    frames.some((frame) => frame.frame < startFrame || frame.frame > endFrame)
  )
    throw new Error(`${path} frame bounds are invalid`);
  return {
    id,
    kind,
    contentIdentity: requireIdentity(payload.contentIdentity, `${path}.contentIdentity`),
    pattern: requireBoundedString(payload.pattern, `${path}.pattern`, 1_024),
    prefix: requireBoundedString(payload.prefix, `${path}.prefix`, 1_024),
    extension: requireBoundedString(payload.extension, `${path}.extension`, 32),
    padding: requireBoundedInteger(payload.padding, `${path}.padding`, 1, 32),
    startFrame,
    endFrame,
    missingFrames: requireBoundedArray(
      payload.missingFrames,
      `${path}.missingFrames`,
      MAX_PERSISTED_SEQUENCE_FRAMES,
    ).map((frame, missingIndex) =>
      requireBoundedInteger(frame, `${path}.missingFrames[${missingIndex}]`, 0, 1_000_000_000),
    ),
    frameRate: decodeFrameRate(payload.frameRate, `${path}.frameRate`),
    missingFramePolicy,
    loop: payload.loop,
    frames,
  };
}

function decodeFrame(value: unknown, path: string): PersistedSequenceFrame {
  const frame = requireRecord(value, path);
  const size = requireBoundedInteger(frame.size, `${path}.size`, 0, 2 * 1024 * 1024 * 1024);
  const storage = decodeStorage(frame.storage, `${path}.storage`);
  const byteIdentity = storage.kind === "external" ? storage.byteIdentity : storage.byteIdentity;
  if (
    byteIdentity &&
    mediaIdentityByteLength(byteIdentity, `${path}.storage.byteIdentity`) !== size
  )
    throw new Error(`${path}.size does not match its byte identity`);
  return {
    frame: requireBoundedInteger(frame.frame, `${path}.frame`, 0, 1_000_000_000),
    name: requireBoundedString(frame.name, `${path}.name`, 1_024),
    size,
    lastModified: requireBoundedInteger(
      frame.lastModified,
      `${path}.lastModified`,
      0,
      Number.MAX_SAFE_INTEGER,
    ),
    type: requireBoundedString(frame.type, `${path}.type`, 256),
    storage,
  };
}

function decodeStorage(value: unknown, path: string): PersistedMediaStorage {
  const storage = requireRecord(value, path);
  if ("runtimeUrl" in storage) throw new Error(`${path}.runtimeUrl must not be persisted`);
  if (storage.kind === "inline") {
    const byteIdentity = requireIdentity(storage.byteIdentity, `${path}.byteIdentity`);
    const declaredBytes = mediaIdentityByteLength(byteIdentity, `${path}.byteIdentity`);
    if (declaredBytes > MAX_PORTABLE_MEDIA_BYTES)
      throw new Error(`${path} exceeds the portable media payload limit`);
    const data = requireBoundedString(
      storage.data,
      `${path}.data`,
      Math.ceil((MAX_PORTABLE_MEDIA_BYTES * 4) / 3) + 8,
    );
    return { kind: "inline", byteIdentity, data };
  }
  if (storage.kind === "external")
    return {
      kind: "external",
      externalPath: requireBoundedString(
        storage.externalPath,
        `${path}.externalPath`,
        MAX_PATH_LENGTH,
      ),
      ...(storage.byteIdentity === undefined
        ? {}
        : { byteIdentity: requireIdentity(storage.byteIdentity, `${path}.byteIdentity`) }),
    };
  if (storage.kind !== "relative") throw new Error(`${path}.kind is unsupported`);
  return {
    kind: "relative",
    relativePath: requireRelativePath(storage.relativePath, `${path}.relativePath`),
    byteIdentity: requireIdentity(storage.byteIdentity, `${path}.byteIdentity`),
    ...(storage.resolvedPath === undefined
      ? {}
      : {
          resolvedPath: requireBoundedString(
            storage.resolvedPath,
            `${path}.resolvedPath`,
            MAX_PATH_LENGTH,
          ),
        }),
  };
}

function payloadStorages(payload: PersistedMediaPayload): readonly PersistedMediaStorage[] {
  return payload.kind === "imageSequence"
    ? payload.frames.map((frame) => frame.storage)
    : [payload.storage];
}

export function isAdvancedSource(
  source: FootageSource,
): source is Extract<FootageSource, { kind: "svg" | "psd" | "imageSequence" }> {
  return source.kind === "svg" || source.kind === "psd" || source.kind === "imageSequence";
}

export function isPersistedMediaSource(source: FootageSource): boolean {
  return isAdvancedSource(source) || isFootageKind(source.kind);
}

function requireRecord(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`${path} must be an object`);
  return value as Record<string, unknown>;
}

function requireBoundedArray(value: unknown, path: string, maximum: number): unknown[] {
  if (!Array.isArray(value) || value.length > maximum)
    throw new Error(`${path} must be a bounded array`);
  return value;
}

function requireBoundedString(value: unknown, path: string, maximum: number): string {
  if (typeof value !== "string" || value.length < 1 || value.length > maximum)
    throw new Error(`${path} must be a bounded string`);
  return value;
}

function requireId(value: unknown, path: string): string {
  return requireBoundedString(value, path, MAX_ID_LENGTH);
}

function requireIdentity(value: unknown, path: string): string {
  return requireBoundedString(value, path, MAX_ID_LENGTH);
}

function requireRelativePath(value: unknown, path: string): string {
  const relative = requireBoundedString(value, path, MAX_PATH_LENGTH);
  if (
    relative.includes("\\") ||
    relative.startsWith("/") ||
    relative.split("/").some((part) => !part || part === "." || part === "..")
  )
    throw new Error(`${path} must stay inside the project bundle`);
  return relative;
}

function requireBoundedInteger(
  value: unknown,
  path: string,
  minimum: number,
  maximum: number,
): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  )
    throw new Error(`${path} must be an integer from ${minimum} through ${maximum}`);
  return value;
}

function requireKind(value: unknown, path: string): PersistedMediaEntry["kind"] {
  if (
    value !== "still" &&
    value !== "video" &&
    value !== "audio" &&
    value !== "svg" &&
    value !== "psd" &&
    value !== "imageSequence"
  )
    throw new Error(`${path} is unsupported`);
  return value;
}

function isFootageKind(value: unknown): value is "still" | "video" | "audio" {
  return value === "still" || value === "video" || value === "audio";
}

function requireMediaExtension(
  value: unknown,
  kind: "still" | "video" | "audio",
  path: string,
): string {
  const extension = requireBoundedString(value, path, 17).toLowerCase();
  const allowed = {
    still: [".avif", ".bmp", ".gif", ".jpeg", ".jpg", ".png", ".tif", ".tiff", ".webp"],
    video: [".avi", ".m4v", ".mkv", ".mov", ".mp4", ".ogv", ".webm"],
    audio: [".aac", ".flac", ".m4a", ".mp3", ".ogg", ".wav"],
  }[kind];
  if (!allowed.includes(extension)) throw new Error(`${path} is unsupported for ${kind} media`);
  return extension;
}

function isPsdImportMode(value: unknown): value is PsdImportMode {
  return value === "merged" || value === "composition" || value === "compositionRetainLayerSizes";
}

function isMissingFramePolicy(value: unknown): value is MissingSequenceFramePolicy {
  return value === "error" || value === "holdPrevious" || value === "nearest";
}

function decodeFrameRate(value: unknown, path: string): { numerator: number; denominator: number } {
  const frameRate = requireRecord(value, path);
  return {
    numerator: requireBoundedInteger(frameRate.numerator, `${path}.numerator`, 1, 1_000_000),
    denominator: requireBoundedInteger(frameRate.denominator, `${path}.denominator`, 1, 1_000_000),
  };
}
