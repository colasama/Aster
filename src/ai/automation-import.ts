import type { Operation } from "../core/editing/operations";
import { createMediaLayerFromFile } from "../core/media/assets";
import { createGltfLayerFromFile } from "../core/media/gltf";
import { activeComposition } from "../core/project/project";
import type { Project } from "../core/types";
import { convertFileSrc } from "../desktop/api";
import {
  type AdvancedImportResult,
  importPsdFile,
  importSvgFile,
} from "../importers/advanced-import";
import { mediaImportRuntime } from "../importers/media-import-runtime";

/** Reads an authorized local file through the asset protocol within the import budget. */
async function readAutomationFile(path: string, mimeType: string, signal: AbortSignal) {
  const url = convertFileSrc(path);
  const response = await fetch(url, { signal });
  if (!response.ok || !response.body) throw new Error("Cannot read the authorized asset");
  const reader = response.body.getReader();
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 96 * 1024 * 1024) throw new Error("Asset exceeds the 96 MiB import budget");
      chunks.push(new Uint8Array(value));
    }
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
  const file = new File(chunks, path.split(/[\\/]/).pop() ?? "asset", { type: mimeType });
  return { file, url };
}

export async function importAutomationAsset(
  project: Project,
  input: Record<string, unknown>,
  signal: AbortSignal,
) {
  const path = input.path as string;
  const mimeType = input.mimeType as string;
  const { file, url } = await readAutomationFile(path, mimeType, signal);
  const composition = activeComposition(project);
  const time = (input.time as number | undefined) ?? 0;
  if (time >= composition.duration) throw new Error("Import time must be inside the composition");
  let imported: AdvancedImportResult;
  if (mimeType === "image/svg+xml") imported = await importSvgFile(file, composition, time);
  else if (mimeType === "image/vnd.adobe.photoshop")
    imported = await importPsdFile(
      Object.assign(file, { sourcePath: path }),
      "composition",
      composition,
      time,
    );
  else if (mimeType.startsWith("model/"))
    imported = {
      sources: [],
      layers: [await createGltfLayerFromFile(file, composition, time)],
      warnings: [],
    };
  else {
    const kind = mimeType.startsWith("image/")
      ? "image"
      : mimeType.startsWith("video/")
        ? "video"
        : "audio";
    const media = await createMediaLayerFromFile(kind, file, composition, time, {
      runtimeUrl: url,
      sourcePath: path,
    });
    imported = { sources: [media.source], layers: [media.layer], warnings: [] };
  }
  for (const layer of imported.layers) {
    if (input.hidden === true) layer.visible = false;
    if (layer.kind !== "video") continue;
    const source = imported.sources.find((candidate) => candidate.id === layer.sourceId);
    // Video without a decodable audio stream would otherwise fail audio-enabled exports.
    if (input.audioEnabled === false || (source?.kind === "video" && !source.audio))
      layer.audioEnabled = false;
  }
  const registeredIds = imported.sources.map((source) => source.id);
  const operations: Operation[] = [];
  for (const source of imported.sources) {
    const existing = project.sources.find(
      (candidate) => candidate.contentIdentity === source.contentIdentity,
    );
    if (!existing) operations.push({ type: "addSource", source });
    else {
      for (const layer of [...imported.layers, ...(imported.composition?.layers ?? [])])
        if (layer.sourceId === source.id) layer.sourceId = existing.id;
      mediaImportRuntime.remove(source.id);
    }
  }
  if (imported.composition)
    operations.push({ type: "addComposition", composition: imported.composition, activate: false });
  operations.push(...imported.layers.map((layer): Operation => ({ type: "addLayer", layer })));
  return {
    operations,
    warnings: imported.warnings,
    layerIds: imported.layers.map((layer) => layer.id),
    dispose: () => {
      for (const id of registeredIds) mediaImportRuntime.remove(id);
    },
  };
}

/**
 * Points every layer that uses `sourceId` (in every composition) at media read from a new file.
 * The new file becomes its own source, so each step is an ordinary undoable operation; the old
 * source is removed unless `removeOld` is false.
 */
export async function relinkAutomationSource(
  project: Project,
  input: Record<string, unknown>,
  signal: AbortSignal,
) {
  const previous = project.sources.find((source) => source.id === input.sourceId);
  if (!previous) throw new Error(`Footage source does not exist: ${String(input.sourceId)}`);
  if (previous.kind !== "still" && previous.kind !== "video" && previous.kind !== "audio")
    throw new Error("Only still, video and audio sources can be relinked");
  const mimeType = input.mimeType as string;
  const kind = mimeType.startsWith("image/")
    ? "image"
    : mimeType.startsWith("video/")
      ? "video"
      : "audio";
  if ((kind === "image" ? "still" : kind) !== previous.kind)
    throw new Error(`Relinking a ${previous.kind} source requires a ${previous.kind} file`);
  const path = input.path as string;
  const { file, url } = await readAutomationFile(path, mimeType, signal);
  const composition = activeComposition(project);
  const media = await createMediaLayerFromFile(kind, file, composition, 0, {
    runtimeUrl: url,
    sourcePath: path,
  });
  const existing = project.sources.find(
    (source) => source.contentIdentity === media.source.contentIdentity,
  );
  if (existing?.id === previous.id) {
    mediaImportRuntime.remove(media.source.id);
    return { operations: [], sourceId: previous.id, retargetedLayers: 0, dispose: () => {} };
  }
  const target = existing ?? media.source;
  if (existing) mediaImportRuntime.remove(media.source.id);
  const operations: Operation[] = existing ? [] : [{ type: "addSource", source: media.source }];
  let retargetedLayers = 0;
  for (const candidate of project.compositions) {
    const layers = candidate.layers.filter((layer) => layer.sourceId === previous.id);
    if (layers.length === 0) continue;
    operations.push({ type: "setActiveComposition", compositionId: candidate.id });
    for (const layer of layers)
      operations.push({ type: "setLayerSource", layerId: layer.id, sourceId: target.id });
    retargetedLayers += layers.length;
  }
  if (operations.some((operation) => operation.type === "setActiveComposition"))
    operations.push({ type: "setActiveComposition", compositionId: project.activeCompositionId });
  if (input.removeOld !== false) operations.push({ type: "removeSource", sourceId: previous.id });
  return {
    operations,
    sourceId: target.id,
    retargetedLayers,
    dispose: () => {
      if (!existing) mediaImportRuntime.remove(media.source.id);
    },
  };
}
