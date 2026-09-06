import { createMediaLayerFromFile } from "../core/assets";
import { createGltfLayerFromFile } from "../core/gltf";
import type { Operation } from "../core/operations";
import { activeComposition } from "../core/project";
import type { Project } from "../core/types";
import { convertFileSrc } from "../desktop/api";
import {
  type AdvancedImportResult,
  importPsdFile,
  importSvgFile,
} from "../importers/advanced-import";
import { mediaImportRuntime } from "../importers/media-import-runtime";

export async function importAutomationAsset(
  project: Project,
  input: Record<string, unknown>,
  signal: AbortSignal,
) {
  const path = input.path as string;
  const mimeType = input.mimeType as string;
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
