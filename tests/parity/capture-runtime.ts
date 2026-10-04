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
import { normalizeRawFrameRgba } from "../../src/renderer/gpu/raw-frame-png";
import { WebGpuRenderer } from "../../src/renderer/webgpu-renderer";
import {
  assertCaptureMedia,
  captureComposition,
  prepareCaptureAudio,
  prepareCapturePlugins,
} from "./capture-resources";
import type { CaptureRuntime } from "./capture-runner";

export const productionCaptureRuntime: CaptureRuntime = {
  async open(assignment, health) {
    let renderer: WebGpuRenderer | undefined;
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
      const activeRenderer = renderer;
      const initialize_ms = performance.now() - initializeStarted;
      const pipeline = new ProductionBeautyFramePipeline(
        createViewportBeautyFrameBackend(activeRenderer, canvas),
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
        async readback(time) {
          const raw = await pipeline.readback(
            createBeautyFrameRequest({
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
          return normalizeRawFrameRgba(raw, assignment.case.size.width, assignment.case.size.height)
            .buffer;
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
