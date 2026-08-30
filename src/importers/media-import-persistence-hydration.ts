import type { Project } from "../core/types";
import { detectImageSequence } from "./image-sequence";
import { mediaBytesIdentity } from "./media-import-identity";
import {
  type HydrateMediaImportOptions,
  isAdvancedSource,
  MAX_NATIVE_PSD_BYTES,
  MAX_PORTABLE_MEDIA_BYTES,
  validatePersistedMediaImports,
} from "./media-import-persistence-codec";
import {
  assertIdentity,
  exactArrayBuffer,
  loadStorage,
  resolvedStoragePath,
  runtimeUrlForStorage,
  storageByteIdentity,
} from "./media-import-persistence-storage";
import {
  mediaImportRuntime,
  type RuntimeMediaRegistration,
  type RuntimeSequenceFile,
} from "./media-import-runtime";
import { parsePsd } from "./psd";
import { planPsdImport } from "./psd-composition";
import { parseSvgSource } from "./svg";

export async function hydratePersistedMediaImports(
  project: Project,
  input: unknown,
  options: HydrateMediaImportOptions = {},
): Promise<void> {
  const advanced = project.sources.filter(isAdvancedSource);
  if (input === undefined) {
    const errors = new Map(
      advanced.map((source) => [
        source.id,
        `Saved project does not contain the ${source.kind} payload for ${source.name}`,
      ]),
    );
    mediaImportRuntime.replace([], errors);
    return;
  }
  const persisted = validatePersistedMediaImports(input);
  const sources = new Map(project.sources.map((source) => [source.id, source]));
  const payloads = new Map(persisted.payloads.map((payload) => [payload.id, payload]));
  const registrations: RuntimeMediaRegistration[] = [];
  const sourceUpdates: Array<{
    source: Project["sources"][number];
    runtimeUrl: string;
    relativePath?: string;
  }> = [];
  const disposers: Array<() => void> = [];
  try {
    const psdDocuments = new Map<string, Awaited<ReturnType<typeof parsePsd>>>();
    const psdBytes = new Map<string, Uint8Array>();
    for (const [index, entry] of persisted.entries.entries()) {
      const path = `mediaImports.entries[${index}]`;
      const source = sources.get(entry.sourceId);
      if (!source) throw new Error(`${path} references missing source ${entry.sourceId}`);
      if (source.kind !== entry.kind)
        throw new Error(`${path} kind does not match source ${source.name}`);
      assertIdentity(source.contentIdentity, entry.contentIdentity, `${path}.contentIdentity`);
      const payload = payloads.get(entry.payloadId);
      if (!payload || payload.kind !== entry.kind)
        throw new Error(`${path} references a missing or mismatched payload`);
      if (
        (entry.kind === "still" || entry.kind === "video" || entry.kind === "audio") &&
        source.kind === entry.kind &&
        payload.kind === entry.kind
      ) {
        assertIdentity(source.contentIdentity, payload.contentIdentity, `${path}.contentIdentity`);
        if (source.mimeType !== payload.mimeType)
          throw new Error(`${path} MIME type does not match source ${source.name}`);
        const resolved = await runtimeUrlForStorage(payload.storage, options, `${path}.payload`);
        const resolvedPath = resolvedStoragePath(payload.storage, options);
        if (resolved.dispose) disposers.push(resolved.dispose);
        sourceUpdates.push({
          source,
          runtimeUrl: resolved.url,
          ...(payload.storage.kind === "relative"
            ? { relativePath: payload.storage.relativePath }
            : {}),
        });
        registrations.push({
          sourceId: source.id,
          value: {
            kind: source.kind,
            ...(resolvedPath ? { originalPath: resolvedPath } : {}),
          },
          ...(resolved.dispose ? { dispose: resolved.dispose } : {}),
        });
        continue;
      }
      if (entry.kind === "svg" && source.kind === "svg" && payload.kind === "svg") {
        const bytes = await loadStorage(
          payload.storage,
          options,
          `${path}.payload`,
          MAX_PORTABLE_MEDIA_BYTES,
        );
        assertIdentity(payload.contentIdentity, mediaBytesIdentity(bytes), `${path} SVG payload`);
        const parsed = parseSvgSource(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
        if (
          parsed.width !== payload.width ||
          parsed.height !== payload.height ||
          source.width !== parsed.width ||
          source.height !== parsed.height
        )
          throw new Error(`${path} SVG dimensions do not match the footage source`);
        registrations.push({ sourceId: source.id, value: { kind: "svg", parsed } });
        continue;
      }
      if (entry.kind === "psd" && source.kind === "psd" && payload.kind === "psd") {
        assertIdentity(
          entry.documentIdentity,
          payload.documentIdentity,
          `${path}.documentIdentity`,
        );
        assertIdentity(
          source.contentIdentity,
          `${entry.documentIdentity}:${entry.importMode}:${entry.layerKey}`,
          `${path} PSD layer identity`,
        );
        let bytes = psdBytes.get(payload.id);
        let document = psdDocuments.get(payload.id);
        if (!bytes || !document) {
          bytes = await loadStorage(
            payload.storage,
            options,
            `${path}.payload`,
            MAX_NATIVE_PSD_BYTES,
          );
          assertIdentity(
            payload.documentIdentity,
            mediaBytesIdentity(bytes),
            `${path} PSD document`,
          );
          document = await parsePsd(exactArrayBuffer(bytes));
          psdBytes.set(payload.id, bytes);
          psdDocuments.set(payload.id, document);
        }
        const planned = planPsdImport(document, entry.importMode, source.name).layers.find(
          (layer) => layer.key === entry.layerKey,
        );
        if (!planned || planned.sectionType)
          throw new Error(`${path} PSD layer key ${entry.layerKey} is unavailable`);
        const [cropX, cropY, cropWidth, cropHeight] = planned.pixelCrop;
        const originalPath = resolvedStoragePath(payload.storage, options);
        if (
          cropWidth < 1 ||
          cropHeight < 1 ||
          planned.sourceSize[0] !== source.width ||
          planned.sourceSize[1] !== source.height ||
          source.layerCount !== document.layers.length
        )
          throw new Error(`${path} PSD layer bounds do not match the footage source`);
        registrations.push({
          sourceId: source.id,
          value: {
            kind: "psd",
            documentIdentity: entry.documentIdentity,
            importMode: entry.importMode,
            layerKey: entry.layerKey,
            documentBytes: bytes,
            ...(originalPath ? { originalPath } : {}),
            decodedWidth: Math.max(1, planned.sourceRectangle.right - planned.sourceRectangle.left),
            decodedHeight: Math.max(
              1,
              planned.sourceRectangle.bottom - planned.sourceRectangle.top,
            ),
            crop: [cropX, cropY, cropWidth, cropHeight],
            pixels: planned.pixels,
          },
        });
        continue;
      }
      if (
        entry.kind === "imageSequence" &&
        source.kind === "imageSequence" &&
        payload.kind === "imageSequence"
      ) {
        assertIdentity(
          source.contentIdentity,
          payload.contentIdentity,
          `${path} image sequence identity`,
        );
        const frames: Array<{ frame: number; file: RuntimeSequenceFile }> = [];
        const urls: string[] = [];
        for (const [frameIndex, frame] of payload.frames.entries()) {
          const framePath = `${path}.frames[${frameIndex}]`;
          const resolved = await runtimeUrlForStorage(frame.storage, options, framePath);
          const resolvedPath = resolvedStoragePath(frame.storage, options);
          if (resolved.dispose) {
            urls.push(resolved.url);
            disposers.push(resolved.dispose);
          }
          frames.push({
            frame: frame.frame,
            file: {
              name: frame.name,
              size: frame.size,
              lastModified: frame.lastModified,
              type: frame.type,
              url: resolved.url,
              byteIdentity: storageByteIdentity(frame.storage),
              ...(resolvedPath ? { path: resolvedPath } : {}),
            },
          });
        }
        const detected = detectImageSequence(
          frames.map((frame) => frame.file),
          frames[0]?.file.name,
        );
        if (
          detected.pattern !== payload.pattern ||
          detected.startFrame !== payload.startFrame ||
          detected.endFrame !== payload.endFrame ||
          source.pattern !== payload.pattern ||
          source.startFrame !== payload.startFrame ||
          source.endFrame !== payload.endFrame ||
          !sameNumbers(detected.missingFrames, payload.missingFrames)
        )
          throw new Error(`${path} image sequence bounds or pattern do not match`);
        registrations.push({
          sourceId: source.id,
          value: {
            kind: "imageSequence",
            selection: { ...detected, frames },
            frameRate: { ...payload.frameRate },
            missingFramePolicy: payload.missingFramePolicy,
            loop: payload.loop,
          },
          ...(urls.length > 0
            ? {
                dispose: () => {
                  for (const url of urls) URL.revokeObjectURL(url);
                },
              }
            : {}),
        });
      }
    }
    const represented = new Set(registrations.map((registration) => registration.sourceId));
    const errors = new Map<string, string>();
    for (const source of advanced)
      if (!represented.has(source.id))
        errors.set(
          source.id,
          `Saved project is missing the ${source.kind} payload for ${source.name}`,
        );
    for (const update of sourceUpdates) {
      delete update.source.dataUrl;
      update.source.runtimeUrl = update.runtimeUrl;
      if (update.relativePath) update.source.relativePath = update.relativePath;
      else delete update.source.relativePath;
    }
    mediaImportRuntime.replace(registrations, errors);
    disposers.length = 0;
  } catch (error) {
    for (const dispose of disposers) dispose();
    throw error;
  }
}

function sameNumbers(left: readonly number[], right: readonly number[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
