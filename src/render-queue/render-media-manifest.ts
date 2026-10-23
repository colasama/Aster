import type { FootageSource, Project } from "../core/types";
import { mediaBytesIdentity } from "../importers/media-import-identity";
import type {
  RuntimeImageSequence,
  RuntimeMediaImport,
  RuntimePsdLayer,
  RuntimeSequenceFile,
} from "../importers/media-import-runtime";
import { mediaImportRuntime, runtimeSourceLocator } from "../importers/media-import-runtime";
import { parsePsd } from "../importers/psd";
import { planPsdImport } from "../importers/psd-composition";
import { parseSvgSource } from "../importers/svg";

import {
  CURRENT_RENDER_MEDIA_MANIFEST_VERSION,
  MAX_LOCATOR_CHARACTERS,
  MAX_RENDER_MEDIA_ENTRIES,
  MAX_RENDER_MEDIA_INLINE_BYTES,
  MAX_RENDER_MEDIA_SNAPSHOT_CHARACTERS,
  parseRenderMediaManifest,
  type RenderMediaEntry,
  type RenderMediaEntryBase,
  type RenderMediaLocator,
  type RenderMediaManifestV1,
  type RenderMediaPayload,
} from "./render-media-codec";

export {
  CURRENT_RENDER_MEDIA_MANIFEST_VERSION,
  EMPTY_RENDER_MEDIA_SNAPSHOT,
  MAX_RENDER_MEDIA_INLINE_BYTES,
  MAX_RENDER_MEDIA_SNAPSHOT_CHARACTERS,
  parseRenderMediaManifest,
  type RenderMediaManifestV1,
} from "./render-media-codec";

type CapturedLocator =
  | RenderMediaLocator
  | { kind: "inline-pending"; mimeType: string; bytes: Promise<Uint8Array> };

type CapturedEntry =
  | Exclude<RenderMediaEntry, { kind: "locator" } | { kind: "imageSequence" }>
  | (RenderMediaEntryBase & { kind: "locator"; locator: CapturedLocator })
  | (RenderMediaEntryBase & {
      kind: "imageSequence";
      selection: Omit<RuntimeImageSequence["selection"], "frames"> & {
        frames: Array<{
          frame: number;
          file: Omit<RuntimeSequenceFile, "url"> & { locator: CapturedLocator };
        }>;
      };
      frameRate: { numerator: number; denominator: number };
      missingFramePolicy: RuntimeImageSequence["missingFramePolicy"];
      loop: boolean;
    });

export interface CapturedRenderMediaManifest {
  entries: CapturedEntry[];
  payloads: Array<{ id: string; kind: RenderMediaPayload["kind"]; bytes: Uint8Array }>;
}

/**
 * Synchronously fixes source identities, runtime registry state and blob fetches at queue time.
 * Expensive encoding and I/O may finish later without observing subsequent editor mutations.
 */
export function captureRenderMediaManifest(
  project: Project,
  compositionId: string,
): CapturedRenderMediaManifest {
  const sourceById = new Map(project.sources.map((source) => [source.id, source]));
  const entries: CapturedEntry[] = [];
  const payloads: CapturedRenderMediaManifest["payloads"] = [];
  const documentPayloads = new Map<string, { id: string; sourceBytes: Uint8Array }>();
  const referenced = referencedSourceIds(project, compositionId);
  let inlineBytes = 0;

  for (const sourceId of referenced) {
    const source = sourceById.get(sourceId);
    if (!source) throw new Error(`Render media source ${sourceId} is missing from the project`);
    const base: RenderMediaEntryBase = {
      sourceId,
      contentIdentity: source.contentIdentity,
      sourceKind: source.kind,
    };
    const runtime = mediaImportRuntime.get(sourceId);
    if (isAdvancedSource(source)) {
      if (!runtime || runtime.kind !== source.kind)
        throw new Error(`Render media runtime for ${source.name} (${sourceId}) is unavailable`);
      if (runtime.kind === "svg") {
        entries.push({ ...base, kind: "svg", parsed: structuredClone(runtime.parsed) });
      } else if (runtime.kind === "imageSequence") {
        entries.push(captureSequence(base, runtime));
      } else {
        let payloadId: string;
        const fallback = !runtime.documentBytes;
        if (runtime.documentBytes) {
          const existing = documentPayloads.get(runtime.documentIdentity);
          if (existing) {
            if (
              existing.sourceBytes !== runtime.documentBytes &&
              !equalBytes(existing.sourceBytes, runtime.documentBytes)
            )
              throw new Error(`PSD document identity mismatch for ${source.name} (${sourceId})`);
            payloadId = existing.id;
          } else {
            payloadId = `psd:${runtime.documentIdentity}`;
            const bytes = new Uint8Array(runtime.documentBytes);
            inlineBytes += bytes.byteLength;
            assertInlineLimit(inlineBytes);
            payloads.push({ id: payloadId, kind: "psdDocument", bytes });
            documentPayloads.set(runtime.documentIdentity, {
              id: payloadId,
              sourceBytes: runtime.documentBytes,
            });
          }
        } else {
          payloadId = `rgba:${source.contentIdentity}`;
          const bytes = new Uint8Array(
            runtime.pixels.buffer.slice(
              runtime.pixels.byteOffset,
              runtime.pixels.byteOffset + runtime.pixels.byteLength,
            ),
          );
          inlineBytes += bytes.byteLength;
          assertInlineLimit(inlineBytes);
          payloads.push({ id: payloadId, kind: "rgba", bytes });
        }
        entries.push({
          ...base,
          kind: "psd",
          documentIdentity: runtime.documentIdentity,
          importMode: runtime.importMode,
          layerKey: runtime.layerKey,
          payloadId,
          fallback,
          decodedWidth: runtime.decodedWidth,
          decodedHeight: runtime.decodedHeight,
          crop: [...runtime.crop],
        });
      }
      continue;
    }
    if (source.dataUrl) continue;
    if (!source.runtimeUrl)
      throw new Error(
        `Render media source ${source.name} (${sourceId}) has no recoverable locator`,
      );
    entries.push({ ...base, kind: "locator", locator: captureLocator(source, source.runtimeUrl) });
  }
  if (entries.length > MAX_RENDER_MEDIA_ENTRIES)
    throw new Error("Render media entry count exceeds the supported limit");
  return { entries, payloads };
}

export async function serializeRenderMediaManifest(
  captured: CapturedRenderMediaManifest,
): Promise<string> {
  let inlineBytes = captured.payloads.reduce(
    (total, payload) => total + payload.bytes.byteLength,
    0,
  );
  assertInlineLimit(inlineBytes);
  const entries: RenderMediaEntry[] = [];
  for (const entry of captured.entries) {
    if (entry.kind === "locator") {
      const resolved = await materializeLocator(entry.locator);
      if (resolved.kind === "inline") inlineBytes += dataUrlByteLength(resolved.dataUrl);
      assertInlineLimit(inlineBytes);
      entries.push({ ...entry, locator: resolved });
      continue;
    }
    if (entry.kind === "imageSequence") {
      const frames = [];
      for (const frame of entry.selection.frames) {
        const locator = await materializeLocator(frame.file.locator);
        if (locator.kind === "inline") inlineBytes += dataUrlByteLength(locator.dataUrl);
        assertInlineLimit(inlineBytes);
        frames.push({ ...frame, file: { ...frame.file, locator } });
      }
      entries.push({ ...entry, selection: { ...entry.selection, frames } });
      continue;
    }
    entries.push(entry);
  }
  const manifest: RenderMediaManifestV1 = {
    version: CURRENT_RENDER_MEDIA_MANIFEST_VERSION,
    entries,
    payloads: await Promise.all(
      captured.payloads.map(async (payload) => ({
        id: payload.id,
        kind: payload.kind,
        identity: mediaBytesIdentity(payload.bytes),
        bytes: await bytesToBase64Async(payload.bytes),
      })),
    ),
  };
  const snapshot = JSON.stringify(manifest);
  if (snapshot.length > MAX_RENDER_MEDIA_SNAPSHOT_CHARACTERS)
    throw new Error("Render media manifest exceeds the supported snapshot limit");
  return snapshot;
}

/** Synchronous compatibility path for callers whose captured resources contain no Blob URLs. */
export function serializeRenderMediaManifestSync(captured: CapturedRenderMediaManifest): string {
  const entries = captured.entries.map((entry): RenderMediaEntry => {
    if (entry.kind === "locator") {
      if (entry.locator.kind === "inline-pending")
        throw new Error("Blob-backed render media requires asynchronous queue capture");
      return { ...entry, locator: entry.locator };
    }
    if (entry.kind === "imageSequence") {
      return {
        ...entry,
        selection: {
          ...entry.selection,
          frames: entry.selection.frames.map((frame) => {
            if (frame.file.locator.kind === "inline-pending")
              throw new Error("Blob-backed image sequences require asynchronous queue capture");
            return { ...frame, file: { ...frame.file, locator: frame.file.locator } };
          }),
        },
      };
    }
    return entry;
  });
  const snapshot = JSON.stringify({
    version: CURRENT_RENDER_MEDIA_MANIFEST_VERSION,
    entries,
    payloads: captured.payloads.map((payload) => ({
      id: payload.id,
      kind: payload.kind,
      identity: mediaBytesIdentity(payload.bytes),
      bytes: bytesToBase64(payload.bytes),
    })),
  } satisfies RenderMediaManifestV1);
  parseRenderMediaManifest(snapshot);
  return snapshot;
}

export async function createRenderMediaSnapshot(
  project: Project,
  compositionId: string,
): Promise<string> {
  return serializeRenderMediaManifest(captureRenderMediaManifest(project, compositionId));
}

export interface RenderMediaHydrationLease {
  dispose(): void;
}

/** Validates identities and hydrates the isolated RenderHost before any frame is submitted. */
export async function hydrateRenderMediaSnapshot(
  project: Project,
  snapshot: string,
): Promise<RenderMediaHydrationLease> {
  const manifest = parseRenderMediaManifest(snapshot);
  const sourceById = new Map(project.sources.map((source) => [source.id, source]));
  const payloadById = new Map(manifest.payloads.map((payload) => [payload.id, payload]));
  const previous = new Map<
    string,
    { runtimeUrl?: string; runtime?: RuntimeMediaImport; insertedRuntime: boolean }
  >();
  const parsedPsd = new Map<string, Awaited<ReturnType<typeof parsePsd>>>();
  try {
    for (const entry of manifest.entries) {
      const source = sourceById.get(entry.sourceId);
      if (!source) throw new Error(`Render media source ${entry.sourceId} is missing`);
      if (source.contentIdentity !== entry.contentIdentity || source.kind !== entry.sourceKind)
        throw new Error(`Render media identity mismatch for ${entry.sourceId}`);
      previous.set(entry.sourceId, {
        ...(source.runtimeUrl ? { runtimeUrl: source.runtimeUrl } : {}),
        ...(mediaImportRuntime.get(entry.sourceId)
          ? { runtime: mediaImportRuntime.get(entry.sourceId) }
          : {}),
        insertedRuntime: entry.kind !== "locator",
      });
      if (entry.kind === "locator") {
        source.runtimeUrl = locatorUrl(entry.locator);
      } else if (entry.kind === "svg") {
        const parsed = parseSvgSource(entry.parsed.sanitized);
        if (
          parsed.width !== entry.parsed.width ||
          parsed.height !== entry.parsed.height ||
          parsed.nodeCount !== entry.parsed.nodeCount ||
          parsed.viewBox.some((value, index) => value !== entry.parsed.viewBox[index])
        )
          throw new Error(`Render media SVG metadata mismatch for ${entry.sourceId}`);
        verifyRecognizedIdentity(entry.contentIdentity, new TextEncoder().encode(parsed.sanitized));
        source.runtimeUrl = runtimeSourceLocator(source.id);
        mediaImportRuntime.register(source.id, {
          kind: "svg",
          parsed,
        });
      } else if (entry.kind === "imageSequence") {
        source.runtimeUrl = runtimeSourceLocator(source.id);
        mediaImportRuntime.register(source.id, {
          kind: "imageSequence",
          selection: {
            ...entry.selection,
            frames: entry.selection.frames.map((frame) => ({
              ...frame,
              file: { ...frame.file, url: locatorUrl(frame.file.locator) },
            })),
          },
          frameRate: { ...entry.frameRate },
          missingFramePolicy: entry.missingFramePolicy,
          loop: entry.loop,
        });
      } else {
        const payload = payloadById.get(entry.payloadId);
        if (!payload) throw new Error(`Render media payload ${entry.payloadId} is missing`);
        const bytes = base64ToBytes(payload.bytes);
        if (mediaBytesIdentity(bytes) !== payload.identity)
          throw new Error(`Render media payload identity mismatch for ${entry.payloadId}`);
        let runtime: RuntimePsdLayer;
        if (payload.kind === "psdDocument") {
          verifyRecognizedIdentity(entry.documentIdentity, bytes);
          let document = parsedPsd.get(payload.id);
          if (!document) {
            document = await parsePsd(bytes.slice().buffer as ArrayBuffer);
            parsedPsd.set(payload.id, document);
          }
          const planned = planPsdImport(document, entry.importMode, "RenderHost").layers.find(
            (candidate) => candidate.key === entry.layerKey,
          );
          if (!planned) throw new Error(`PSD render layer ${entry.layerKey} is unavailable`);
          runtime = {
            kind: "psd",
            documentIdentity: entry.documentIdentity,
            importMode: entry.importMode,
            layerKey: entry.layerKey,
            documentBytes: bytes,
            decodedWidth: Math.max(1, planned.sourceRectangle.right - planned.sourceRectangle.left),
            decodedHeight: Math.max(
              1,
              planned.sourceRectangle.bottom - planned.sourceRectangle.top,
            ),
            crop: [...planned.pixelCrop],
            pixels: planned.pixels,
          };
        } else {
          runtime = {
            kind: "psd",
            documentIdentity: entry.documentIdentity,
            importMode: entry.importMode,
            layerKey: entry.layerKey,
            decodedWidth: entry.decodedWidth,
            decodedHeight: entry.decodedHeight,
            crop: [...entry.crop],
            pixels: new Uint8ClampedArray(bytes.buffer, bytes.byteOffset, bytes.byteLength),
          };
        }
        source.runtimeUrl = runtimeSourceLocator(source.id);
        mediaImportRuntime.register(source.id, runtime);
      }
    }
  } catch (error) {
    restoreHydratedMedia(project, previous);
    throw error;
  }
  let disposed = false;
  return {
    dispose: () => {
      if (disposed) return;
      disposed = true;
      restoreHydratedMedia(project, previous);
    },
  };
}

function captureSequence(base: RenderMediaEntryBase, runtime: RuntimeImageSequence): CapturedEntry {
  return {
    ...base,
    kind: "imageSequence",
    selection: {
      ...structuredClone({
        pattern: runtime.selection.pattern,
        prefix: runtime.selection.prefix,
        extension: runtime.selection.extension,
        padding: runtime.selection.padding,
        startFrame: runtime.selection.startFrame,
        endFrame: runtime.selection.endFrame,
        missingFrames: runtime.selection.missingFrames,
      }),
      frames: runtime.selection.frames.map((frame) => ({
        frame: frame.frame,
        file: {
          name: frame.file.name,
          size: frame.file.size,
          lastModified: frame.file.lastModified,
          type: frame.file.type,
          ...(frame.file.byteIdentity ? { byteIdentity: frame.file.byteIdentity } : {}),
          // Object URLs must be pinned before the first await. Native asset URLs stay as locators
          // so Electron can stream large sequences into the job-owned snapshot without inflating
          // the bounded JSON manifest.
          locator: captureLocator(undefined, frame.file.url, frame.file.type),
        },
      })),
    },
    frameRate: { ...runtime.frameRate },
    missingFramePolicy: runtime.missingFramePolicy,
    loop: runtime.loop,
  };
}

function captureLocator(
  source: FootageSource | undefined,
  url: string,
  mimeType = source?.mimeType ?? "application/octet-stream",
  forceInline = false,
): CapturedLocator {
  if (url.startsWith("data:")) return { kind: "inline", dataUrl: url };
  if (forceInline || url.startsWith("blob:")) {
    // Starting fetch synchronously pins this exact Blob generation even if editor state changes or
    // its object URL is later revoked while the queue snapshot is encoded.
    const bytes = fetch(url).then(async (response) => {
      if (!response.ok)
        throw new Error(`Render media inline request failed with HTTP ${response.status}`);
      return new Uint8Array(await response.arrayBuffer());
    });
    return { kind: "inline-pending", mimeType, bytes };
  }
  if (source?.relativePath)
    return { kind: "bundle", url: boundedLocator(url), relativePath: source.relativePath };
  return { kind: "session", url: boundedLocator(url) };
}

async function materializeLocator(locator: CapturedLocator): Promise<RenderMediaLocator> {
  if (locator.kind !== "inline-pending") return locator;
  const bytes = await locator.bytes;
  return {
    kind: "inline",
    dataUrl: `data:${locator.mimeType};base64,${await bytesToBase64Async(bytes)}`,
  };
}

function referencedSourceIds(project: Project, rootCompositionId: string): string[] {
  const compositionById = new Map(
    project.compositions.map((composition) => [composition.id, composition]),
  );
  const pending = [rootCompositionId];
  const visited = new Set<string>();
  const sources = new Set<string>();
  while (pending.length > 0) {
    const compositionId = pending.pop();
    if (!compositionId || visited.has(compositionId)) continue;
    visited.add(compositionId);
    const composition = compositionById.get(compositionId);
    if (!composition) throw new Error(`Render composition dependency ${compositionId} is missing`);
    for (const layer of composition.layers) {
      if (layer.sourceId) sources.add(layer.sourceId);
      if (layer.kind === "precomposition" && layer.sourceCompositionId)
        pending.push(layer.sourceCompositionId);
    }
  }
  return [...sources].sort();
}

function restoreHydratedMedia(
  project: Project,
  previous: Map<
    string,
    { runtimeUrl?: string; runtime?: RuntimeMediaImport; insertedRuntime: boolean }
  >,
): void {
  const sourceById = new Map(project.sources.map((source) => [source.id, source]));
  for (const [sourceId, state] of previous) {
    const source = sourceById.get(sourceId);
    if (source) {
      if (state.runtimeUrl) source.runtimeUrl = state.runtimeUrl;
      else delete source.runtimeUrl;
    }
    if (!state.insertedRuntime) continue;
    if (state.runtime) mediaImportRuntime.register(sourceId, state.runtime);
    else mediaImportRuntime.remove(sourceId);
  }
}

function locatorUrl(locator: RenderMediaLocator): string {
  if (locator.kind === "inline") return locator.dataUrl;
  return locator.url;
}

function isAdvancedSource(
  source: FootageSource,
): source is Extract<FootageSource, { kind: "svg" | "psd" | "imageSequence" }> {
  return source.kind === "svg" || source.kind === "psd" || source.kind === "imageSequence";
}

function bytesToBase64(bytes: Uint8Array): string {
  const chunks: string[] = [];
  for (let offset = 0; offset < bytes.length; offset += 0x8000)
    chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + 0x8000)));
  return btoa(chunks.join(""));
}

function bytesToBase64Async(bytes: Uint8Array): Promise<string> {
  if (typeof FileReader === "undefined") return Promise.resolve(bytesToBase64(bytes));
  return new Promise((resolveBase64, reject) => {
    const reader = new FileReader();
    reader.addEventListener(
      "load",
      () => {
        const value = typeof reader.result === "string" ? reader.result : "";
        const comma = value.indexOf(",");
        if (comma < 0) reject(new Error("Render media base64 encoding failed"));
        else resolveBase64(value.slice(comma + 1));
      },
      { once: true },
    );
    reader.addEventListener(
      "error",
      () => reject(reader.error ?? new Error("Render media encoding failed")),
      {
        once: true,
      },
    );
    reader.readAsDataURL(new Blob([bytes.slice().buffer]));
  });
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1)
    if (left[index] !== right[index]) return false;
  return true;
}

function verifyRecognizedIdentity(identity: string, bytes: Uint8Array): void {
  if (identity.startsWith("fnv64:") && mediaBytesIdentity(bytes) !== identity)
    throw new Error("Render media content identity mismatch");
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function dataUrlByteLength(value: string): number {
  const comma = value.indexOf(",");
  if (comma < 0) throw new Error("Render media inline locator is invalid");
  const length = value.length - comma - 1;
  return Math.floor((length * 3) / 4);
}

function assertInlineLimit(bytes: number): void {
  if (bytes > MAX_RENDER_MEDIA_INLINE_BYTES)
    throw new Error("Render media inline resources exceed the 64 MiB limit");
}

function boundedLocator(value: string): string {
  if (!boundedText(value, MAX_LOCATOR_CHARACTERS))
    throw new Error("Render media locator is invalid");
  return value;
}

function boundedText(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength;
}
