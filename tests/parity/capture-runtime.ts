import { sharedAudioDecodeCache } from "../../src/core/audio/audio-decode-cache";
import { activateProjectFonts } from "../../src/core/media/project-font-runtime";
import { setProjectPluginRuntimes } from "../../src/core/plugins/plugin-runtime";
import { loadProjectFromPath } from "../../src/core/project/project-file";
import { mediaImportRuntime } from "../../src/importers/media-import-runtime";
import {
  createBeautyFrameRequest,
  createViewportBeautyFrameBackend,
  ProductionBeautyFramePipeline,
} from "../../src/renderer/compositing/beauty-frame";
import { FrameBundleRenderer } from "../../src/renderer/compositing/frame-bundle-renderer";
import { decodeFramePlan, encodeFramePlan } from "../../src/renderer/frame-plan/codec";
import { normalizeRawFrameRgba } from "../../src/renderer/gpu/raw-frame-png";
import { WebGpuRenderer } from "../../src/renderer/webgpu-renderer";
import {
  assertCaptureMedia,
  captureComposition,
  prepareCaptureAudio,
  prepareCapturePlugins,
} from "./capture-resources";
import type { CaptureRuntime } from "./capture-runner";
import { captureSnapshotIdentity } from "./capture-snapshot";

export const productionCaptureRuntime: CaptureRuntime = {
  async open(assignment, health) {
    let renderer: WebGpuRenderer | undefined;
    let replay: FrameBundleRenderer | undefined;
    let replayPixels: Uint8ClampedArray<ArrayBuffer> | undefined;
    let productionPixels: ArrayBuffer | undefined;
    const canvas = document.createElement("canvas");
    canvas.width = assignment.case.size.width;
    canvas.height = assignment.case.size.height;
    document.body.append(canvas);
    const dispose = async () => {
      try {
        if (renderer) {
          try {
            await renderer.complete();
          } finally {
            renderer.dispose();
          }
        }
      } finally {
        replay?.destroy();
        canvas.remove();
        sharedAudioDecodeCache.clear();
        mediaImportRuntime.clear();
        activateProjectFonts({ fonts: [] });
        await setProjectPluginRuntimes([]);
      }
    };
    try {
      const loadStarted = performance.now();
      const { project } = await loadProjectFromPath(assignment.projectPath);
      const snapshot = captureSnapshotIdentity(assignment.caseHash);
      const composition = captureComposition(assignment, project);
      assertCaptureMedia(project, composition);
      const plugins = await prepareCapturePlugins(project);
      if (
        assignment.case.features.includes("feature:audio-analysis") ||
        plugins?.report.plugins.some((plugin) => plugin.capabilities.includes("audio_analysis"))
      )
        await prepareCaptureAudio(project, composition);
      health.assertHealthy();
      const load_ms = performance.now() - loadStarted;
      const initializeStarted = performance.now();
      renderer = await WebGpuRenderer.create(canvas);
      replay = await FrameBundleRenderer.create();
      const activeReplay = replay;
      const activeRenderer = renderer;
      const capturedRasters = new Map<string, string>();
      const initialize_ms = performance.now() - initializeStarted;
      const pipeline = new ProductionBeautyFramePipeline(
        createViewportBeautyFrameBackend(activeRenderer, canvas, async (bundle) => {
          replayPixels = await activeReplay.render({
            ...bundle,
            plan: decodeFramePlan(encodeFramePlan(bundle.plan.metadata, bundle.plan.blobs)),
          });
        }),
      );
      // The runner awaits frame publication before starting the next readback in this case.
      const destination = new ArrayBuffer(
        assignment.case.size.width * assignment.case.size.height * 4,
      );
      const assertHealthy = () => {
        assertCaptureMedia(project, composition);
        health.assertHealthy(activeRenderer.diagnostics, activeRenderer.productionRenderError);
      };
      assertHealthy();
      return {
        composition,
        load_ms,
        initialize_ms,
        diagnostics: () => structuredClone(activeRenderer.diagnostics),
        assertHealthy,
        productionPixels: () => productionPixels,
        async captureRasters() {
          const rasters = await activeRenderer.captureRasterResources(
            snapshot.snapshotScope,
            capturedRasters,
          );
          await activeRenderer.complete();
          assertHealthy();
          return rasters;
        },
        async readback(time) {
          replayPixels = undefined;
          productionPixels = undefined;
          const raw = await pipeline.readback(
            createBeautyFrameRequest({
              snapshot,
              project,
              composition,
              time,
              ...assignment.case.size,
              antiAliasing: assignment.case.aa,
            }),
            true,
            destination,
          );
          // Submission completion also gives asynchronous GPU validation a failure boundary.
          await activeRenderer.complete();
          assertHealthy();
          if (raw.pixels !== destination)
            throw new Error("Capture readback did not use its owned destination");
          const expected = normalizeRawFrameRgba(
            raw,
            assignment.case.size.width,
            assignment.case.size.height,
          );
          const actual = replayPixels as Uint8ClampedArray<ArrayBuffer> | undefined;
          if (!actual || actual.length !== expected.length)
            throw new Error("Supplied frame replay is absent");
          productionPixels = expected.buffer;
          return actual.buffer;
        },
        dispose,
      };
    } catch (error) {
      try {
        await dispose();
      } catch (cleanupError) {
        throw new Error(`${String(error)}\nCapture cleanup: ${String(cleanupError)}`);
      }
      throw error;
    }
  },
};
