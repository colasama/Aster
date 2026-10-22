import { createHash } from "node:crypto";
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { antiAliasingScale, isAntiAliasingMode } from "../src/core/rendering/anti-aliasing.js";
import type { NativePreviewSnapshot } from "../src/core/rendering/native-preview-protocol.js";
import { validateRenderSnapshotIdentity } from "../src/core/rendering/render-snapshot.js";
import { freezePreviewPlugins, type ResolvePreviewPlugins } from "./native-preview-plugins.js";

const modes = [
  "beauty",
  "linearColor",
  "luminance",
  "alpha",
  "depthFog",
  "depthOfField",
  "selectionIsolation",
  "vectorMotionBlur",
  "normal",
  "objectId",
  "materialId",
  "worldPosition",
  "motionVector",
];
export function parsePreviewSnapshot(value: unknown): NativePreviewSnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Preview snapshot must be an object");
  const input = value as NativePreviewSnapshot;
  validateRenderSnapshotIdentity(input);
  if (
    typeof input.projectDocument !== "string" ||
    Buffer.byteLength(input.projectDocument) > 67108864 ||
    typeof input.compositionId !== "string" ||
    !input.compositionId ||
    input.compositionId.length > 4096 ||
    ![input.width, input.height].every(
      (size) => Number.isSafeInteger(size) && size > 0 && size <= 16384,
    ) ||
    !Number.isFinite(input.time) ||
    !isAntiAliasingMode(input.antiAliasing) ||
    !modes.includes(input.visualization) ||
    !Number.isSafeInteger(input.memoryBudgetMb) ||
    input.memoryBudgetMb < 64 ||
    input.memoryBudgetMb > 32768 ||
    (input.selectedLayerId !== undefined &&
      (typeof input.selectedLayerId !== "string" || input.selectedLayerId.length > 4096))
  )
    throw new Error("Invalid native preview snapshot");
  const scale = antiAliasingScale(input.antiAliasing);
  if (
    input.runtimeAssets !== undefined &&
    (!Array.isArray(input.runtimeAssets) ||
      input.runtimeAssets.length > 50000 ||
      input.runtimeAssets.some(
        (asset) =>
          !asset ||
          typeof asset.relativePath !== "string" ||
          asset.relativePath.length > 4096 ||
          typeof asset.url !== "string" ||
          asset.url.length > 16384,
      ))
  )
    throw new Error("Invalid preview asset locators");
  if (Math.max(input.width, input.height) * scale > 16384)
    throw new Error("Preview supersampling exceeds texture limits");
  return structuredClone(input);
}

export interface PreviewSnapshotRuntime {
  executable: string;
  host: string;
  bundle: string;
  bridge: string;
}

export interface PreviewSnapshotMediaCache {
  key: string;
  imports: unknown;
  paths: Map<string, string>;
}

/** Persist through the application bridge, then publish an immutable file beside admitted assets. */
export async function preparePreviewSnapshot(options: {
  directory: string;
  index: number;
  snapshot: NativePreviewSnapshot;
  runtime: PreviewSnapshotRuntime;
  mediaCache?: PreviewSnapshotMediaCache;
  resolvePlugins?: ResolvePreviewPlugins;
  save(
    directory: string,
    document: unknown,
    assets: NativePreviewSnapshot["runtimeAssets"],
  ): Promise<void>;
}) {
  const { directory, index, snapshot, runtime } = options;
  const document = JSON.parse(snapshot.projectDocument);
  const key = createHash("sha256")
    .update(
      JSON.stringify({
        mediaImports: document.mediaImports,
        runtimeAssets: snapshot.runtimeAssets,
        sourceIdentities: document.sources?.map(
          (source: { id: string; contentIdentity?: string; relativePath?: string }) => [
            source.id,
            source.contentIdentity,
            source.relativePath,
          ],
        ),
      }),
    )
    .digest("hex");
  let mediaCache = options.mediaCache;
  let persisted: typeof document;
  if (mediaCache?.key === key) {
    // Asset payload identities are immutable within this private session. Editing geometry or time
    // reuses the admitted copies without repeatedly decoding and persisting every media payload.
    persisted = document;
    if (mediaCache.imports === undefined) delete persisted.mediaImports;
    else persisted.mediaImports = structuredClone(mediaCache.imports);
    for (const source of persisted.sources ?? []) {
      const replacement = mediaCache.paths.get(source.relativePath);
      if (replacement) source.relativePath = replacement;
    }
  } else {
    const original = new Map<string, string>(
      (document.sources ?? []).map((source: { id: string; relativePath: string }) => [
        source.id,
        source.relativePath,
      ]),
    );
    await options.save(directory, document, snapshot.runtimeAssets);
    persisted = JSON.parse(await readFile(join(directory, "project.json"), "utf8"));
    const paths = new Map<string, string>();
    for (const source of persisted.sources ?? []) {
      const before = original.get(source.id);
      if (before && source.relativePath && before !== source.relativePath)
        paths.set(before, source.relativePath);
    }
    mediaCache = { key, imports: persisted.mediaImports, paths };
  }
  const plugins = await freezePreviewPlugins(directory, persisted, options.resolvePlugins);
  const scope = plugins.identity
    ? `${snapshot.snapshotScope}:plugins:${plugins.identity}`
    : snapshot.snapshotScope;
  // Bound the entire private store, including media retained by previous revisions.
  const pending = [directory];
  let bytes = 0,
    files = 0;
  while (pending.length) {
    const current = pending.pop();
    if (!current) break;
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isSymbolicLink()) throw new Error("Preview store cannot contain links");
      if (entry.isDirectory()) pending.push(path);
      else {
        bytes += (await stat(path)).size;
        files++;
      }
      if (bytes > 2147483648 || files + pending.length > 50000)
        throw new Error("Preview store exceeds its byte or file budget");
    }
  }
  const project = join(directory, `preview-${index}.json`),
    request = join(directory, `request-${index}.json`);
  await writeFile(project, JSON.stringify(persisted), { flag: "wx" });
  if (
    !persisted.compositions?.some(
      (composition: { id: string }) => composition.id === snapshot.compositionId,
    )
  )
    throw new Error("Preview composition is absent");
  const scale = antiAliasingScale(snapshot.antiAliasing);
  await writeFile(
    request,
    JSON.stringify({
      frame: {
        snapshotScope: scope,
        projectRevision: snapshot.projectRevision,
        compositionId: snapshot.compositionId,
        time: snapshot.time,
        target: { width: snapshot.width, height: snapshot.height },
        renderTarget: { width: snapshot.width * scale, height: snapshot.height * scale },
        antiAliasing: snapshot.antiAliasing,
        shadowsEnabled: true,
      },
      settings: {
        resources: {
          visualization: snapshot.visualization,
          locale: "en-US",
          layouts: {},
          surface: {
            revision: index,
            maxTextureDimension: 16384,
            memoryBudgetMb: snapshot.memoryBudgetMb,
            renderScale: scale,
          },
          maximumRasterDimension: 8192,
          maximumRasterPixels: 67108864,
        },
        selectedLayerId: snapshot.selectedLayerId ?? null,
        shadowMapSize: 1024,
      },
      plugins: plugins.plugins,
      unavailableGenerators: plugins.unavailableGenerators,
      rasterProvider: {
        executable: runtime.executable,
        arguments: [runtime.host],
        bundle: runtime.bundle,
        bridge: runtime.bridge,
        timeoutMs: 120000,
        cacheBytes: 67108864,
      },
    }),
    { flag: "wx" },
  );
  return { project, request, mediaCache, scope };
}
