import type { FootageSource, Project } from "../core/types";
import { mediaBytesIdentity, mediaTextIdentity } from "./media-import-identity";
import {
  isAdvancedSource,
  isPersistedMediaSource,
  MAX_MEDIA_IMPORT_ENTRIES,
  MAX_NATIVE_FOOTAGE_BYTES,
  MAX_PERSISTED_SEQUENCE_FRAMES,
  MAX_PORTABLE_MEDIA_BYTES,
  MEDIA_IMPORT_SIDECAR_VERSION,
  type MediaImportPersistenceMode,
  type PersistedMediaEntry,
  type PersistedMediaImports,
  type PersistedMediaPayload,
  type PersistedMediaStorage,
  type PersistedSequenceFrame,
} from "./media-import-persistence-codec";
import {
  assertIdentity,
  chargePortableBudget,
  exactArrayBuffer,
  fetchRuntimeBytes,
  inlineStorage,
} from "./media-import-persistence-storage";
import {
  mediaImportRuntime,
  type RuntimeImageSequence,
  type RuntimePsdLayer,
} from "./media-import-runtime";

export async function createPersistedMediaImports(
  project: Project,
  mode: MediaImportPersistenceMode,
): Promise<PersistedMediaImports | undefined> {
  const persistedSources = project.sources.filter((source) => {
    if (!isPersistedMediaSource(source)) return false;
    if (isAdvancedSource(source)) return true;
    const runtime = mediaImportRuntime.get(source.id);
    return Boolean(source.dataUrl || (runtime && runtime.kind === source.kind));
  });
  if (persistedSources.length === 0) return undefined;
  if (persistedSources.length > MAX_MEDIA_IMPORT_ENTRIES)
    throw new Error("Project contains too many persisted media imports");
  const entries: PersistedMediaEntry[] = [];
  const payloads = new Map<string, PersistedMediaPayload>();
  const budget = { bytes: 0 };
  for (const source of persistedSources) {
    const runtime = mediaImportRuntime.get(source.id);
    if (source.kind === "still" || source.kind === "video" || source.kind === "audio") {
      if (runtime && runtime.kind !== source.kind)
        throw new Error(`${source.name} has mismatched runtime footage state`);
      const extension = mediaExtension(source.name, source.mimeType);
      const payloadId = `footage:${source.kind}:${source.contentIdentity}:${mediaTextIdentity(
        `${source.mimeType}:${extension}`,
      )}`;
      if (!payloads.has(payloadId)) {
        const storage = await footageStorage(source, runtime, mode, budget);
        payloads.set(payloadId, {
          id: payloadId,
          kind: source.kind,
          contentIdentity: source.contentIdentity,
          mimeType: source.mimeType,
          extension,
          storage,
        });
      }
      entries.push({
        sourceId: source.id,
        kind: source.kind,
        contentIdentity: source.contentIdentity,
        payloadId,
      });
      continue;
    }
    if (!runtime || runtime.kind !== source.kind)
      throw new Error(`${source.name} has no recoverable ${source.kind} import payload`);
    if (source.kind === "svg" && runtime.kind === "svg") {
      const bytes = new TextEncoder().encode(runtime.parsed.sanitized);
      assertIdentity(source.contentIdentity, mediaBytesIdentity(bytes), `${source.name} SVG`);
      const payloadId = `svg:${source.contentIdentity}`;
      if (!payloads.has(payloadId)) {
        chargePortableBudget(budget, bytes.byteLength);
        payloads.set(payloadId, {
          id: payloadId,
          kind: "svg",
          contentIdentity: source.contentIdentity,
          width: runtime.parsed.width,
          height: runtime.parsed.height,
          storage: inlineStorage(bytes),
        });
      }
      entries.push({
        sourceId: source.id,
        kind: "svg",
        contentIdentity: source.contentIdentity,
        payloadId,
      });
      continue;
    }
    if (source.kind === "psd" && runtime.kind === "psd") {
      const expectedSourceIdentity = `${runtime.documentIdentity}:${runtime.importMode}:${runtime.layerKey}`;
      assertIdentity(source.contentIdentity, expectedSourceIdentity, `${source.name} PSD layer`);
      const payloadId = `psd:${runtime.documentIdentity}`;
      if (!payloads.has(payloadId)) {
        const storage = await psdStorage(runtime, mode, budget);
        payloads.set(payloadId, {
          id: payloadId,
          kind: "psd",
          documentIdentity: runtime.documentIdentity,
          storage,
        });
      }
      entries.push({
        sourceId: source.id,
        kind: "psd",
        contentIdentity: source.contentIdentity,
        payloadId,
        documentIdentity: runtime.documentIdentity,
        importMode: runtime.importMode,
        layerKey: runtime.layerKey,
      });
      continue;
    }
    if (source.kind === "imageSequence" && runtime.kind === "imageSequence") {
      const payloadId = `sequence:${source.contentIdentity}`;
      if (!payloads.has(payloadId))
        payloads.set(payloadId, await sequencePayload(payloadId, source, runtime, mode, budget));
      entries.push({
        sourceId: source.id,
        kind: "imageSequence",
        contentIdentity: source.contentIdentity,
        payloadId,
      });
    }
  }
  return { version: MEDIA_IMPORT_SIDECAR_VERSION, entries, payloads: [...payloads.values()] };
}

async function footageStorage(
  source: Extract<FootageSource, { kind: "still" | "video" | "audio" }>,
  runtime: ReturnType<typeof mediaImportRuntime.get>,
  mode: MediaImportPersistenceMode,
  budget: { bytes: number },
): Promise<PersistedMediaStorage> {
  const originalPath =
    runtime && (runtime.kind === "still" || runtime.kind === "video" || runtime.kind === "audio")
      ? runtime.originalPath
      : undefined;
  if (mode === "native" && originalPath) return { kind: "external", externalPath: originalPath };
  const locator = source.dataUrl ?? source.runtimeUrl;
  if (!locator) throw new Error(`${source.name} has no recoverable footage payload`);
  const bytes = await fetchRuntimeBytes(
    locator,
    `${source.name} footage`,
    MAX_NATIVE_FOOTAGE_BYTES,
  );
  await assertFootageIdentity(source.contentIdentity, bytes, source.name);
  chargePortableBudget(budget, bytes.byteLength);
  return inlineStorage(bytes);
}

async function assertFootageIdentity(
  expected: string,
  bytes: Uint8Array,
  name: string,
): Promise<void> {
  if (!expected.startsWith("sha256:")) return;
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", exactArrayBuffer(bytes)));
  const actual = `sha256:${Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  )}`;
  if (actual !== expected) throw new Error(`${name} footage identity mismatch`);
}

function mediaExtension(name: string, mimeType: string): string {
  const named = /\.([a-z0-9]{1,16})$/i.exec(name)?.[1]?.toLowerCase();
  if (named) return `.${named}`;
  const mime = mimeType.split(";", 1)[0].trim().toLowerCase();
  if (mime === "audio/mp4") return ".m4a";
  if (mime === "audio/mpeg") return ".mp3";
  const subtype = /^[^/]+\/([a-z0-9.+-]+)$/i.exec(mime)?.[1]?.split(/[.+-]/)[0];
  if (subtype && /^[a-z0-9]{1,16}$/i.test(subtype)) return `.${subtype.toLowerCase()}`;
  throw new Error(`${name} has no safe media file extension`);
}

async function psdStorage(
  runtime: RuntimePsdLayer,
  mode: MediaImportPersistenceMode,
  budget: { bytes: number },
): Promise<PersistedMediaStorage> {
  if (mode === "native" && runtime.originalPath)
    return { kind: "external", externalPath: runtime.originalPath };
  if (!runtime.documentBytes)
    throw new Error("PSD original payload is unavailable; re-import the PSD before saving");
  assertIdentity(
    runtime.documentIdentity,
    mediaBytesIdentity(runtime.documentBytes),
    "PSD document payload",
  );
  chargePortableBudget(budget, runtime.documentBytes.byteLength);
  return inlineStorage(runtime.documentBytes);
}

async function sequencePayload(
  payloadId: string,
  source: Extract<FootageSource, { kind: "imageSequence" }>,
  runtime: RuntimeImageSequence,
  mode: MediaImportPersistenceMode,
  budget: { bytes: number },
): Promise<PersistedMediaPayload> {
  const selection = runtime.selection;
  if (selection.frames.length < 1 || selection.frames.length > MAX_PERSISTED_SEQUENCE_FRAMES)
    throw new Error(
      `Image sequence ${source.name} must contain at most ${MAX_PERSISTED_SEQUENCE_FRAMES} persisted frames`,
    );
  if (
    selection.pattern !== source.pattern ||
    selection.startFrame !== source.startFrame ||
    selection.endFrame !== source.endFrame
  )
    throw new Error(`Image sequence ${source.name} metadata no longer matches its source`);
  const frames: PersistedSequenceFrame[] = [];
  for (const selectionFrame of selection.frames) {
    const file = selectionFrame.file;
    let storage: PersistedMediaStorage;
    if (mode === "native" && file.path) {
      storage = {
        kind: "external",
        externalPath: file.path,
        ...(file.byteIdentity ? { byteIdentity: file.byteIdentity } : {}),
      };
    } else {
      const bytes = await fetchRuntimeBytes(
        file.url,
        `image sequence frame ${selectionFrame.frame}`,
        MAX_PORTABLE_MEDIA_BYTES,
      );
      if (bytes.byteLength !== file.size)
        throw new Error(`Image sequence frame ${selectionFrame.frame} size changed before save`);
      chargePortableBudget(budget, bytes.byteLength);
      storage = inlineStorage(bytes);
    }
    frames.push({
      frame: selectionFrame.frame,
      name: file.name,
      size: file.size,
      lastModified: file.lastModified,
      type: file.type,
      storage,
    });
  }
  return {
    id: payloadId,
    kind: "imageSequence",
    contentIdentity: source.contentIdentity,
    pattern: selection.pattern,
    prefix: selection.prefix,
    extension: selection.extension,
    padding: selection.padding,
    startFrame: selection.startFrame,
    endFrame: selection.endFrame,
    missingFrames: [...selection.missingFrames],
    frameRate: { ...runtime.frameRate },
    missingFramePolicy: runtime.missingFramePolicy,
    loop: runtime.loop,
    frames,
  };
}
