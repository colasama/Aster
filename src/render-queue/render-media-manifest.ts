import type { FootageSource, Project } from "../core/types";
import { mediaBytesIdentity, mediaIdentityByteLength } from "../importers/media-import-identity";
import type {
  RuntimeImageSequence,
  RuntimeMediaImport,
  RuntimePsdLayer,
  RuntimeSequenceFile,
  RuntimeSvgSource,
} from "../importers/media-import-runtime";
import { mediaImportRuntime, runtimeSourceLocator } from "../importers/media-import-runtime";
import { parsePsd } from "../importers/psd";
import { planPsdImport } from "../importers/psd-composition";
import { parseSvgSource } from "../importers/svg";

export const CURRENT_RENDER_MEDIA_MANIFEST_VERSION = 1 as const;
export const EMPTY_RENDER_MEDIA_SNAPSHOT = '{"version":1,"entries":[],"payloads":[]}' as const;
export const MAX_RENDER_MEDIA_SNAPSHOT_CHARACTERS = 96 * 1024 * 1024;
export const MAX_RENDER_MEDIA_INLINE_BYTES = 64 * 1024 * 1024;
const MAX_RENDER_MEDIA_ENTRIES = 100_000;
const MAX_LOCATOR_CHARACTERS = 16_384;

type RenderMediaLocator =
  | { kind: "session"; url: string }
  | { kind: "bundle"; url: string; relativePath: string; root?: string }
  | { kind: "inline"; dataUrl: string };

type RenderMediaEntryBase = {
  sourceId: string;
  contentIdentity: string;
  sourceKind: FootageSource["kind"];
};

type RenderMediaEntry =
  | (RenderMediaEntryBase & { kind: "locator"; locator: RenderMediaLocator })
  | (RenderMediaEntryBase & { kind: "svg"; parsed: RuntimeSvgSource["parsed"] })
  | (RenderMediaEntryBase & {
      kind: "psd";
      documentIdentity: string;
      importMode: RuntimePsdLayer["importMode"];
      layerKey: string;
      payloadId: string;
      fallback: boolean;
      decodedWidth: number;
      decodedHeight: number;
      crop: readonly [number, number, number, number];
    })
  | (RenderMediaEntryBase & {
      kind: "imageSequence";
      selection: Omit<RuntimeImageSequence["selection"], "frames"> & {
        frames: Array<{
          frame: number;
          file: Omit<RuntimeSequenceFile, "url"> & { locator: RenderMediaLocator };
        }>;
      };
      frameRate: { numerator: number; denominator: number };
      missingFramePolicy: RuntimeImageSequence["missingFramePolicy"];
      loop: boolean;
    });

interface RenderMediaPayload {
  id: string;
  kind: "psdDocument" | "rgba";
  identity: string;
  bytes: string;
}

export interface RenderMediaManifestV1 {
  version: typeof CURRENT_RENDER_MEDIA_MANIFEST_VERSION;
  entries: RenderMediaEntry[];
  payloads: RenderMediaPayload[];
}

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

export function parseRenderMediaManifest(snapshot: string): RenderMediaManifestV1 {
  if (!snapshot || snapshot.length > MAX_RENDER_MEDIA_SNAPSHOT_CHARACTERS)
    throw new Error("Render media manifest size is invalid");
  let value: unknown;
  try {
    value = JSON.parse(snapshot);
  } catch {
    throw new Error("Render media manifest must be valid JSON");
  }
  if (!isRecord(value) || value.version !== CURRENT_RENDER_MEDIA_MANIFEST_VERSION)
    throw new Error("Render media manifest version is unsupported");
  if (!Array.isArray(value.entries) || value.entries.length > MAX_RENDER_MEDIA_ENTRIES)
    throw new Error("Render media manifest entries are invalid");
  if (!Array.isArray(value.payloads) || value.payloads.length > MAX_RENDER_MEDIA_ENTRIES)
    throw new Error("Render media manifest payloads are invalid");
  // The producer is same-version trusted code, while every security-sensitive local locator is
  // independently authorized in Electron. These structural checks prevent corrupted queue files
  // from reaching hydration with unbounded or ambiguous containers.
  const sourceIds = new Set<string>();
  let inlineBytes = 0;
  for (const entry of value.entries) {
    if (
      !isRecord(entry) ||
      !boundedText(entry.sourceId, 256) ||
      !boundedText(entry.contentIdentity, 512) ||
      !isSourceKind(entry.sourceKind) ||
      !isEntryKind(entry.kind)
    )
      throw new Error("Render media manifest entry is invalid");
    if (sourceIds.has(entry.sourceId)) throw new Error("Render media source ids must be unique");
    sourceIds.add(entry.sourceId);
    if (entry.kind === "locator") {
      inlineBytes += validateLocator(entry.locator);
    } else if (entry.kind === "svg") {
      if (entry.sourceKind !== "svg")
        throw new Error("Render media SVG kind does not match source");
      validateSvg(entry.parsed);
    } else if (entry.kind === "psd") {
      if (
        entry.sourceKind !== "psd" ||
        !boundedText(entry.documentIdentity, 512) ||
        (entry.importMode !== "merged" &&
          entry.importMode !== "composition" &&
          entry.importMode !== "compositionRetainSizes") ||
        !boundedText(entry.layerKey, 1_024) ||
        !boundedText(entry.payloadId, 768) ||
        typeof entry.fallback !== "boolean" ||
        !boundedInteger(entry.decodedWidth, 1, 32_768) ||
        !boundedInteger(entry.decodedHeight, 1, 32_768) ||
        !validCrop(entry.crop)
      )
        throw new Error("Render media PSD entry is invalid");
    } else {
      if (entry.sourceKind !== "imageSequence")
        throw new Error("Render media image sequence kind does not match source");
      inlineBytes += validateSequence(entry);
    }
  }
  const payloadIds = new Set<string>();
  const payloadKinds = new Map<string, RenderMediaPayload["kind"]>();
  for (const payload of value.payloads) {
    if (
      !isRecord(payload) ||
      !boundedText(payload.id, 768) ||
      (payload.kind !== "psdDocument" && payload.kind !== "rgba") ||
      !/^fnv64:[a-f0-9]{16}:\d+$/i.test(String(payload.identity)) ||
      !boundedText(payload.bytes, MAX_RENDER_MEDIA_SNAPSHOT_CHARACTERS)
    )
      throw new Error("Render media manifest payload is invalid");
    if (payloadIds.has(payload.id)) throw new Error("Render media payload ids must be unique");
    payloadIds.add(payload.id);
    payloadKinds.set(payload.id, payload.kind);
    const decodedBytes = decodedBase64Length(payload.bytes);
    if (
      mediaIdentityByteLength(String(payload.identity), "Render media payload identity") !==
      decodedBytes
    )
      throw new Error("Render media payload identity length is invalid");
    inlineBytes += decodedBytes;
  }
  for (const entry of value.entries) {
    if (!isRecord(entry) || entry.kind !== "psd") continue;
    const payloadKind = payloadKinds.get(String(entry.payloadId));
    if (!payloadKind || (entry.fallback === true) !== (payloadKind === "rgba"))
      throw new Error("Render media PSD payload kind is invalid");
  }
  if (inlineBytes > MAX_RENDER_MEDIA_INLINE_BYTES)
    throw new Error("Render media inline payload exceeds the supported limit");
  return value as unknown as RenderMediaManifestV1;
}

function validateLocator(value: unknown): number {
  if (!isRecord(value)) throw new Error("Render media locator is invalid");
  if (value.kind === "inline") {
    if (!boundedText(value.dataUrl, MAX_RENDER_MEDIA_SNAPSHOT_CHARACTERS))
      throw new Error("Render media inline locator is invalid");
    const comma = value.dataUrl.indexOf(",");
    if (comma < 5 || !value.dataUrl.slice(0, comma).toLowerCase().endsWith(";base64"))
      throw new Error("Render media inline locator must be a base64 data URL");
    return decodedBase64Length(value.dataUrl.slice(comma + 1));
  }
  if (value.kind !== "session" && value.kind !== "bundle")
    throw new Error("Render media locator kind is invalid");
  if (!boundedText(value.url, MAX_LOCATOR_CHARACTERS))
    throw new Error("Render media locator URL is invalid");
  if (value.kind === "bundle") {
    if (!boundedText(value.relativePath, 4_096))
      throw new Error("Render media bundle-relative path is invalid");
    if (value.root !== undefined && !boundedText(value.root, 4_096))
      throw new Error("Render media bundle root is invalid");
  }
  return 0;
}

function validateSvg(value: unknown): void {
  if (
    !isRecord(value) ||
    !boundedNumber(value.width, 0, 32_768) ||
    !boundedNumber(value.height, 0, 32_768) ||
    !boundedInteger(value.nodeCount, 1, 100_000) ||
    !boundedText(value.sanitized, 16 * 1024 * 1024) ||
    !Array.isArray(value.viewBox) ||
    value.viewBox.length !== 4 ||
    value.viewBox.some((entry) => typeof entry !== "number" || !Number.isFinite(entry))
  )
    throw new Error("Render media SVG entry is invalid");
}

function validateSequence(entry: Record<string, unknown>): number {
  if (
    !isRecord(entry.selection) ||
    !Array.isArray(entry.selection.frames) ||
    entry.selection.frames.length < 1 ||
    entry.selection.frames.length > MAX_RENDER_MEDIA_ENTRIES ||
    !isRecord(entry.frameRate) ||
    !boundedInteger(entry.frameRate.numerator, 1, 1_000_000) ||
    !boundedInteger(entry.frameRate.denominator, 1, 1_000_000) ||
    (entry.missingFramePolicy !== "error" &&
      entry.missingFramePolicy !== "holdPrevious" &&
      entry.missingFramePolicy !== "nearest") ||
    typeof entry.loop !== "boolean"
  )
    throw new Error("Render media image sequence entry is invalid");
  let bytes = 0;
  const frames = new Set<number>();
  for (const frame of entry.selection.frames) {
    if (
      !isRecord(frame) ||
      !boundedInteger(frame.frame, 0, Number.MAX_SAFE_INTEGER) ||
      frames.has(frame.frame) ||
      !isRecord(frame.file) ||
      !boundedText(frame.file.name, 1_024) ||
      !boundedInteger(frame.file.size, 0, Number.MAX_SAFE_INTEGER) ||
      !boundedNumber(frame.file.lastModified, 0, Number.MAX_SAFE_INTEGER) ||
      !boundedText(frame.file.type, 256)
    )
      throw new Error("Render media image sequence frame is invalid");
    frames.add(frame.frame);
    bytes += validateLocator(frame.file.locator);
  }
  return bytes;
}

function validCrop(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.length === 4 &&
    value.every((entry) => boundedInteger(entry, 0, 32_768)) &&
    Number(value[2]) > 0 &&
    Number(value[3]) > 0
  );
}

function decodedBase64Length(value: string): number {
  if (!/^[a-zA-Z0-9+/]*={0,2}$/.test(value) || value.length % 4 !== 0)
    throw new Error("Render media base64 payload is invalid");
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  return (value.length / 4) * 3 - padding;
}

function isSourceKind(value: unknown): value is FootageSource["kind"] {
  return ["still", "video", "audio", "imageSequence", "svg", "psd"].includes(String(value));
}

function isEntryKind(value: unknown): value is RenderMediaEntry["kind"] {
  return ["locator", "svg", "psd", "imageSequence"].includes(String(value));
}

function boundedInteger(value: unknown, minimum: number, maximum: number): value is number {
  return Number.isSafeInteger(value) && Number(value) >= minimum && Number(value) <= maximum;
}

function boundedNumber(value: unknown, minimum: number, maximum: number): value is number {
  return (
    typeof value === "number" && Number.isFinite(value) && value >= minimum && value <= maximum
  );
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
