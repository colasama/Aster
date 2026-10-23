import { mediaIdentityByteLength } from "../importers/media-import-identity.js";

export const CURRENT_RENDER_MEDIA_MANIFEST_VERSION = 1 as const;
export const EMPTY_RENDER_MEDIA_SNAPSHOT = '{"version":1,"entries":[],"payloads":[]}' as const;
export const MAX_RENDER_MEDIA_SNAPSHOT_CHARACTERS = 96 * 1024 * 1024;
export const MAX_RENDER_MEDIA_INLINE_BYTES = 64 * 1024 * 1024;
export const MAX_RENDER_MEDIA_ENTRIES = 100_000;
export const MAX_LOCATOR_CHARACTERS = 16_384;

export type RenderMediaLocator =
  | { kind: "session"; url: string }
  | { kind: "bundle"; url: string; relativePath: string; root?: string }
  | { kind: "inline"; dataUrl: string };

export type RenderMediaEntryBase = {
  sourceId: string;
  contentIdentity: string;
  sourceKind: "still" | "video" | "audio" | "svg" | "psd" | "imageSequence";
};

export type RenderMediaEntry =
  | (RenderMediaEntryBase & { kind: "locator"; locator: RenderMediaLocator })
  | (RenderMediaEntryBase & {
      kind: "svg";
      parsed: {
        width: number;
        height: number;
        viewBox: readonly [number, number, number, number];
        sanitized: string;
        nodeCount: number;
      };
    })
  | (RenderMediaEntryBase & {
      kind: "psd";
      documentIdentity: string;
      importMode: "merged" | "composition" | "compositionRetainLayerSizes";
      layerKey: string;
      payloadId: string;
      fallback: boolean;
      decodedWidth: number;
      decodedHeight: number;
      crop: readonly [number, number, number, number];
    })
  | (RenderMediaEntryBase & {
      kind: "imageSequence";
      selection: {
        pattern: string;
        prefix: string;
        extension: string;
        padding: number;
        startFrame: number;
        endFrame: number;
        missingFrames: readonly number[];
      } & {
        frames: Array<{
          frame: number;
          file: {
            name: string;
            size: number;
            lastModified: number;
            type: string;
            path?: string;
            byteIdentity?: string;
          } & { locator: RenderMediaLocator };
        }>;
      };
      frameRate: { numerator: number; denominator: number };
      missingFramePolicy: "error" | "holdPrevious" | "nearest";
      loop: boolean;
    });

export interface RenderMediaPayload {
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
          entry.importMode !== "compositionRetainLayerSizes") ||
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

function isSourceKind(value: unknown): value is RenderMediaEntryBase["sourceKind"] {
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

function boundedText(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
