import { createHash } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { antiAliasingScale } from "../src/core/rendering/anti-aliasing.js";
import {
  MAX_RENDER_SNAPSHOT_BYTES,
  type RenderJobManifest,
} from "../src/core/rendering/render-queue.js";
import {
  EMPTY_RENDER_MEDIA_SNAPSHOT,
  parseRenderMediaManifest,
} from "../src/render-queue/render-media-codec.js";
import { freezePreviewPlugins, type ResolvePreviewPlugins } from "./native-preview-plugins.js";
import type { PreviewSnapshotRuntime } from "./native-preview-snapshot.js";
import { NativeQueueAssetStore } from "./native-queue-assets.js";
import { materializeNativeQueueMedia, selectNativeQueueDocument } from "./native-queue-media.js";
import { normalizeNativeQueueDocument } from "./native-queue-normalize.js";

/** Snapshot strings have separate receipts; hash only the small immutable job configuration here. */
export function nativeQueueConfigurationIdentity(manifest: RenderJobManifest): string {
  const { projectSnapshot: _project, renderMediaSnapshot: _media, ...configuration } = manifest;
  return createHash("sha256").update(JSON.stringify(configuration)).digest("hex");
}

/** Publish a new private project only after every captured media/plugin input has been prepared. */
export async function prepareNativeQueueProject(options: {
  directory: string;
  manifest: RenderJobManifest;
  authorizedPaths: readonly string[];
  runtime: PreviewSnapshotRuntime & { renderer: string };
  resolvePlugins?: ResolvePreviewPlugins;
}) {
  const directory = resolve(options.directory);
  // The caller owns the new directory after this exclusive creation; never remove an existing path.
  await mkdir(directory);
  try {
    const { manifest, runtime } = options;
    if (Buffer.byteLength(manifest.projectSnapshot) > MAX_RENDER_SNAPSHOT_BYTES)
      throw new Error("Native queue project exceeds input budget");
    let authored = JSON.parse(manifest.projectSnapshot);
    if (Number.isInteger(authored?.schemaVersion) && authored.schemaVersion < 10)
      authored = await normalizeNativeQueueDocument(
        directory,
        manifest.projectSnapshot,
        runtime.renderer,
      );
    const document = selectNativeQueueDocument(authored, manifest.compositionId);
    const composition = document.compositions.find((c) => c.id === manifest.compositionId);
    if (
      !composition ||
      composition.width !== manifest.width ||
      composition.height !== manifest.height ||
      composition.frameRate?.numerator !== manifest.frameRate.numerator ||
      composition.frameRate?.denominator !== manifest.frameRate.denominator ||
      !Number.isSafeInteger(manifest.startFrame) ||
      manifest.startFrame < 0 ||
      !Number.isSafeInteger(manifest.endFrameExclusive) ||
      manifest.endFrameExclusive <= manifest.startFrame ||
      !Number.isFinite(composition.duration) ||
      manifest.endFrameExclusive >
        Math.ceil(
          (composition.duration * manifest.frameRate.numerator) / manifest.frameRate.denominator,
        )
    )
      throw new Error(
        "Queue dimensions, clock or frame range differ from the immutable composition",
      );
    const media = parseRenderMediaManifest(
      manifest.renderMediaSnapshot ?? EMPTY_RENDER_MEDIA_SNAPSHOT,
    );
    const retained = await materializeNativeQueueMedia(
      document,
      media,
      new NativeQueueAssetStore(directory, options.authorizedPaths),
    );
    const plugins = await freezePreviewPlugins(directory, document, options.resolvePlugins);
    const digest = (bytes: string) => createHash("sha256").update(bytes).digest("hex");
    let retainedMedia: { path: string; sha256: string } | undefined;
    if (retained) {
      const bytes = JSON.stringify(retained),
        path = join(directory, "retained-media.json");
      await writeFile(path, bytes, { flag: "wx" });
      retainedMedia = { path, sha256: digest(bytes) };
    }
    const project = join(directory, "project.json"),
      request = join(directory, "export.json");
    const projectBytes = JSON.stringify(document);
    if (Buffer.byteLength(projectBytes) > MAX_RENDER_SNAPSHOT_BYTES)
      throw new Error("Prepared queue project exceeds input budget");
    const requestBytes = JSON.stringify({
      settings: {
        resources: {
          visualization: "beauty",
          locale: "en-US",
          layouts: {},
          surface: {
            revision: 1,
            maxTextureDimension: 16384,
            memoryBudgetMb: 512,
            renderScale: antiAliasingScale(manifest.antiAliasing ?? "off"),
          },
          maximumRasterDimension: 8192,
          maximumRasterPixels: 67108864,
        },
        selectedLayerId: null,
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
        ...(retainedMedia ? { retainedMedia } : {}),
      },
    });
    await writeFile(request, requestBytes, { flag: "wx" });
    await writeFile(project, projectBytes, { flag: "wx" });
    return {
      directory,
      project,
      request,
      projectSha256: digest(projectBytes),
      requestSha256: digest(requestBytes),
      configurationSha256: nativeQueueConfigurationIdentity(manifest),
      authoredSnapshotSha256: digest(manifest.projectSnapshot),
      mediaSnapshotSha256: digest(manifest.renderMediaSnapshot ?? EMPTY_RENDER_MEDIA_SNAPSHOT),
      runtimeArguments: [
        "--render-project-input-bytes",
        String(MAX_RENDER_SNAPSHOT_BYTES),
        "--media-catalog-input-bytes",
        String(MAX_RENDER_SNAPSHOT_BYTES),
        "--media-sequence-frames",
        "100000",
        "--project-media-files",
        "100000",
      ],
    };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}
