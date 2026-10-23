import { sourceContentIdentity } from "../src/core/media/source-content-identity.js";
import {
  mediaBytesIdentity,
  mediaIdentityByteLength,
} from "../src/importers/media-import-identity.js";
import type {
  RenderMediaLocator,
  RenderMediaManifestV1,
} from "../src/render-queue/render-media-codec.js";
import type { NativeQueueAssetStore } from "./native-queue-assets.js";

export interface NativeQueueSource extends Record<string, unknown> {
  id: string;
  kind: string;
  contentIdentity: string;
  name: string;
  mimeType: string;
  dataUrl?: string;
  runtimeUrl?: string;
  relativePath?: string;
  width?: number;
  height?: number;
  duration?: number;
}
export interface NativeQueueDocument extends Record<string, unknown> {
  sources: NativeQueueSource[];
  compositions: Array<{
    id: string;
    width: number;
    height: number;
    duration: number;
    frameRate: { numerator: number; denominator: number };
    layers: Array<{
      kind: string;
      sourceId?: string;
      sourceCompositionId?: string;
      generator?: { pluginId: string; nodeType: string };
    }>;
  }>;
}

/** Convert only the immutable captured resources; the authored queue snapshot stays untouched. */
export async function materializeNativeQueueMedia(
  document: NativeQueueDocument,
  manifest: RenderMediaManifestV1,
  assets: NativeQueueAssetStore,
): Promise<RenderMediaManifestV1 | undefined> {
  const sources = new Map(document.sources.map((source) => [source.id, source]));
  if (sources.size !== document.sources.length) throw new Error("Duplicate native queue source");
  const captured = new Map(manifest.entries.map((entry) => [entry.sourceId, entry]));
  const payloads = new Map(manifest.payloads.map((payload) => [payload.id, payload]));
  const entries: Record<string, unknown>[] = [],
    persisted: Record<string, unknown>[] = [];
  const retained: RenderMediaManifestV1 = { version: 1, entries: [], payloads: [] };
  const retainedPayloads = new Set<string>();
  for (const entry of manifest.entries) {
    const source = sources.get(entry.sourceId);
    if (
      !source ||
      source.kind !== entry.sourceKind ||
      source.contentIdentity !== entry.contentIdentity
    )
      throw new Error("Queue media identity differs from the captured project");
  }
  for (const source of document.sources) {
    const entry = captured.get(source.id);
    const payloadId = `queue:${source.id}`;
    const base = {
      sourceId: source.id,
      kind: source.kind,
      contentIdentity: source.contentIdentity,
      payloadId,
    };
    if (!entry || entry.kind === "locator") {
      if (!["still", "video", "audio"].includes(source.kind))
        throw new Error(`Queue source ${source.id} has no captured advanced media`);
      const locator: RenderMediaLocator | undefined =
        entry?.kind === "locator"
          ? entry.locator
          : source.dataUrl
            ? { kind: "inline", dataUrl: source.dataUrl }
            : undefined;
      if (!locator) throw new Error(`Queue source ${source.id} has no immutable media locator`);
      const extension = mediaExtension(source.name, source.mimeType);
      const identityLocator =
        source.dataUrl ??
        source.relativePath ??
        source.runtimeUrl ??
        (locator.kind === "inline" ? locator.dataUrl : locator.url);
      const legacy =
        sourceContentIdentity({ ...source, dataUrl: identityLocator }) === source.contentIdentity;
      const legacyLocator = legacy
        ? identityLocator.startsWith("data:")
          ? { kind: "inline", prefix: identityLocator.slice(0, identityLocator.indexOf(",") + 1) }
          : { kind: "text", value: identityLocator }
        : undefined;
      const storage = await assets.locator(
        locator,
        extension,
        legacy ? undefined : source.contentIdentity,
      );
      entries.push(base);
      persisted.push({
        id: payloadId,
        kind: source.kind,
        contentIdentity: source.contentIdentity,
        mimeType: source.mimeType,
        extension,
        storage,
        ...(legacyLocator ? { legacyLocator } : {}),
      });
    } else if (entry.kind === "svg") {
      const bytes = Buffer.from(entry.parsed.sanitized, "utf8");
      const storage = await assets.inline(bytes, ".svg", source.contentIdentity);
      entries.push(base);
      persisted.push({
        id: payloadId,
        kind: "svg",
        contentIdentity: source.contentIdentity,
        width: entry.parsed.width,
        height: entry.parsed.height,
        storage,
      });
    } else if (entry.kind === "psd") {
      const payload = payloads.get(entry.payloadId);
      if (!payload) throw new Error("Queue PSD payload is missing");
      const bytes = Buffer.from(payload.bytes, "base64");
      if (mediaBytesIdentity(bytes) !== payload.identity)
        throw new Error("Queue PSD payload identity differs");
      if (entry.fallback) {
        if (bytes.length !== entry.decodedWidth * entry.decodedHeight * 4)
          throw new Error("Queue PSD fallback dimensions differ from its pixels");
        retained.entries.push(structuredClone(entry));
        if (!retainedPayloads.has(payload.id)) {
          retained.payloads.push(structuredClone(payload));
          retainedPayloads.add(payload.id);
        }
      } else {
        const storage = await assets.inline(bytes, ".psd", entry.documentIdentity);
        entries.push({
          ...base,
          documentIdentity: entry.documentIdentity,
          importMode: entry.importMode,
          layerKey: entry.layerKey,
        });
        persisted.push({
          id: payloadId,
          kind: "psd",
          documentIdentity: entry.documentIdentity,
          storage,
        });
      }
    } else {
      const frames = [];
      for (const frame of entry.selection.frames) {
        const storage = await assets.locator(
          frame.file.locator,
          mediaExtension(frame.file.name, frame.file.type),
          frame.file.byteIdentity,
        );
        if (mediaIdentityByteLength(storage.byteIdentity) !== frame.file.size)
          throw new Error("Queue sequence frame size differs from its capture");
        frames.push({
          frame: frame.frame,
          name: frame.file.name,
          size: frame.file.size,
          lastModified: frame.file.lastModified,
          type: frame.file.type,
          storage,
        });
      }
      entries.push(base);
      persisted.push({
        id: payloadId,
        kind: "imageSequence",
        contentIdentity: source.contentIdentity,
        ...entry.selection,
        frames,
        frameRate: entry.frameRate,
        missingFramePolicy: entry.missingFramePolicy,
        loop: entry.loop,
      });
    }
    delete source.runtimeUrl;
    delete source.dataUrl;
    delete source.relativePath;
  }
  document.mediaImports = { version: 1, entries, payloads: persisted };
  return retained.entries.length ? retained : undefined;
}

function mediaExtension(name: string, mime: string): string {
  const extension = /\.([a-z0-9]{1,16})$/i.exec(name)?.[1]?.toLowerCase();
  if (extension) return `.${extension}`;
  const types: Record<string, string> = {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/webp": ".webp",
    "audio/wav": ".wav",
    "audio/x-wav": ".wav",
    "audio/mpeg": ".mp3",
    "audio/mp4": ".m4a",
    "video/mp4": ".mp4",
    "video/webm": ".webm",
  };
  const value = types[mime.split(";", 1)[0].trim().toLowerCase()];
  if (!value) throw new Error("Queue media has no supported file extension");
  return value;
}

/** Restrict the private export document to the selected composition dependency graph. */
export function selectNativeQueueDocument(
  value: unknown,
  compositionId: string,
): NativeQueueDocument {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid queue project");
  const document = value as NativeQueueDocument;
  if (
    document.sources === undefined &&
    Number(document.schemaVersion) >= 1 &&
    Number(document.schemaVersion) < 4
  )
    document.sources = [];
  if (!Array.isArray(document.sources) || !Array.isArray(document.compositions))
    throw new Error("Queue project has no source or composition catalog");
  const compositions = new Map(
    document.compositions.map((composition) => [composition.id, composition]),
  );
  if (compositions.size !== document.compositions.length)
    throw new Error("Duplicate queue composition");
  const pending = [compositionId],
    selected = new Set<string>(),
    sourceIds = new Set<string>();
  while (pending.length) {
    const id = pending.pop();
    if (!id || selected.has(id)) continue;
    const composition = compositions.get(id);
    if (!composition || !Array.isArray(composition.layers))
      throw new Error("Queue composition dependency is missing");
    selected.add(id);
    for (const layer of composition.layers) {
      if (layer.sourceId) sourceIds.add(layer.sourceId);
      if (layer.kind === "precomposition" && layer.sourceCompositionId)
        pending.push(layer.sourceCompositionId);
    }
  }
  document.compositions = document.compositions.filter((c) => selected.has(c.id));
  document.sources = document.sources.filter((source) => sourceIds.has(source.id));
  if (document.sources.length !== sourceIds.size)
    throw new Error("Queue source dependency is missing");
  document.activeCompositionId = compositionId;
  const items = new Set([...selected, ...sourceIds]);
  if (document.itemFolderIds && typeof document.itemFolderIds === "object")
    document.itemFolderIds = Object.fromEntries(
      Object.entries(document.itemFolderIds).filter(([id]) => items.has(id)),
    );
  delete document.mediaImports;
  return document;
}
