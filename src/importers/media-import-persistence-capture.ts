import type { FootageSource, Project } from "../core/types";
import { mediaBytesIdentity } from "./media-import-identity";
import {
  isAdvancedSource,
  MAX_MEDIA_IMPORT_ENTRIES,
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
  const advanced = project.sources.filter(isAdvancedSource);
  if (advanced.length === 0) return undefined;
  if (advanced.length > MAX_MEDIA_IMPORT_ENTRIES)
    throw new Error("Project contains too many advanced media imports");
  const entries: PersistedMediaEntry[] = [];
  const payloads = new Map<string, PersistedMediaPayload>();
  const budget = { bytes: 0 };
  for (const source of advanced) {
    const runtime = mediaImportRuntime.get(source.id);
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
