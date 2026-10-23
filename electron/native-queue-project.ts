import { createHash } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { antiAliasingScale } from "../src/core/rendering/anti-aliasing.js";
import type { RenderJobManifest } from "../src/core/rendering/render-queue.js";
import {
  EMPTY_RENDER_MEDIA_SNAPSHOT,
  parseRenderMediaManifest,
} from "../src/render-queue/render-media-codec.js";
import { freezePreviewPlugins, type ResolvePreviewPlugins } from "./native-preview-plugins.js";
import type { PreviewSnapshotRuntime } from "./native-preview-snapshot.js";
import { NativeQueueAssetStore } from "./native-queue-assets.js";
import { materializeNativeQueueMedia, selectNativeQueueDocument } from "./native-queue-media.js";

/** Publish a new private project only after every captured media/plugin input has been prepared. */
export async function prepareNativeQueueProject(options: {
  directory: string;
  manifest: RenderJobManifest;
  authorizedPaths: readonly string[];
  runtime: PreviewSnapshotRuntime;
  resolvePlugins?: ResolvePreviewPlugins;
}) {
  const directory = resolve(options.directory);
  // The caller owns the new directory after this exclusive creation; never remove an existing path.
  await mkdir(directory);
  try {
    const { manifest, runtime } = options;
    if (Buffer.byteLength(manifest.projectSnapshot) > 67_108_864)
      throw new Error("Native queue project exceeds input budget");
    const document = selectNativeQueueDocument(
      JSON.parse(manifest.projectSnapshot),
      manifest.compositionId,
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
    if (Buffer.byteLength(projectBytes) > 67_108_864)
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
      authoredSnapshotSha256: digest(manifest.projectSnapshot),
      mediaSnapshotSha256: digest(manifest.renderMediaSnapshot ?? EMPTY_RENDER_MEDIA_SNAPSHOT),
    };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}
