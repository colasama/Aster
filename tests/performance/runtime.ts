import type { ValidatedRenderHostAssignment } from "../../src/components/render-host/render-host-session";
import { sharedAudioDecodeCache } from "../../src/core/audio/audio-decode-cache";
import type { AudioSourceDecoder } from "../../src/core/audio/audio-export";
import {
  activateProjectFonts,
  prepareProjectFonts,
} from "../../src/core/media/project-font-runtime";
import { setProjectPluginRuntimes } from "../../src/core/plugins/plugin-runtime";
import { loadProjectFromPath } from "../../src/core/project/project-file";
import type { GpuDiagnostics, RendererMetrics } from "../../src/core/types";
import type { Mp4PixelFormat } from "../../src/desktop/api";
import { mediaImportRuntime } from "../../src/importers/media-import-runtime";
import {
  createBeautyFrameRequest,
  createViewportBeautyFrameBackend,
  ProductionBeautyFramePipeline,
} from "../../src/renderer/compositing/beauty-frame";
import type { RawVideoFrame } from "../../src/renderer/gpu/frame-readback";
import { WebGpuRenderer } from "../../src/renderer/webgpu-renderer";
import type { CaptureHealth } from "../parity/capture-health";
import {
  assertCaptureMedia,
  prepareCaptureAudio,
  prepareCapturePlugins,
} from "../parity/capture-resources";
import { captureSnapshotIdentity } from "../parity/capture-snapshot";
import { performanceRenderAssignment } from "./assignment";
import type { PerformanceAssignment } from "./protocol";

export interface PerformanceSession {
  validated: ValidatedRenderHostAssignment;
  pixelFormat: Mp4PixelFormat;
  maxConcurrentReadbacks: number;
  loadMs: number;
  initializeMs: number;
  audioDecoder?: AudioSourceDecoder;
  readback(time: number): Promise<RawVideoFrame>;
  readbackInto?(time: number, destination: ArrayBuffer): Promise<RawVideoFrame>;
  present?(time: number): RendererMetrics;
  complete?(): Promise<void>;
  diagnostics(): GpuDiagnostics;
  assertHealthy(): void;
  dispose(): Promise<void>;
}

export interface PerformanceRuntime {
  open(assignment: PerformanceAssignment, health: CaptureHealth): Promise<PerformanceSession>;
}

export const productionPerformanceRuntime: PerformanceRuntime = {
  async open(assignment, health) {
    const canvas = document.createElement("canvas");
    canvas.width = assignment.case.size.width;
    canvas.height = assignment.case.size.height;
    document.body.append(canvas);
    const abort = new AbortController();
    let renderer: WebGpuRenderer | undefined;
    let verifyResources: (() => void) | undefined;
    const dispose = async () => {
      abort.abort(new DOMException("Performance session ended", "AbortError"));
      try {
        try {
          verifyResources?.();
        } finally {
          if (renderer) {
            try {
              await renderer.complete();
            } finally {
              renderer.dispose();
            }
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
      const validated = performanceRenderAssignment(assignment, project);
      const snapshot = captureSnapshotIdentity(
        assignment.caseHash,
        validated.manifest.projectRevision,
      );
      if (assignment.benchmark.mode === "preview-present") {
        if (
          !["composite-1080p", "composite-4k", "effect-chain-1080p"].includes(assignment.case.id) ||
          project.sources.length > 0 ||
          project.fonts?.length ||
          project.compositions.length !== 1 ||
          validated.composition.environment?.enabled ||
          validated.composition.layers.some(
            (layer) => layer.kind !== "shape" || layer.threeDimensional,
          )
        )
          throw new Error("Preview performance requires the fixed resource-free synthetic scenes");
        await prepareProjectFonts(project);
      }
      verifyResources = () => assertCaptureMedia(validated.project, validated.composition);
      const plugins = await prepareCapturePlugins(validated.project);
      verifyResources();
      if (
        assignment.case.features.includes("feature:audio-analysis") ||
        plugins?.report.plugins.some((plugin) => plugin.capabilities.includes("audio_analysis"))
      )
        await prepareCaptureAudio(validated.project, validated.composition);
      health.assertHealthy();
      const loadMs = performance.now() - loadStarted;
      const initializeStarted = performance.now();
      renderer = await WebGpuRenderer.create(canvas);
      const active = renderer;
      const pipeline = new ProductionBeautyFramePipeline(
        createViewportBeautyFrameBackend(active, canvas),
      );
      const initializeMs = performance.now() - initializeStarted;
      const audioContext =
        assignment.benchmark.mode === "full-mp4"
          ? new OfflineAudioContext(2, 1, 48_000)
          : undefined;
      const assertHealthy = () => {
        health.assertHealthy(active.diagnostics, active.productionRenderError);
      };
      assertHealthy();
      const readback = (time: number, destination?: ArrayBuffer) =>
        pipeline.readback(
          createBeautyFrameRequest({
            snapshot,
            project: validated.project,
            composition: validated.composition,
            time,
            ...assignment.case.size,
            antiAliasing: assignment.case.aa,
          }),
          validated.synchronizeVideo,
          destination,
        );
      return {
        validated,
        pixelFormat: pipeline.pixelFormat,
        maxConcurrentReadbacks: pipeline.maxConcurrentReadbacks,
        loadMs,
        initializeMs,
        ...(audioContext
          ? {
              audioDecoder: async (source) => {
                const buffer = await sharedAudioDecodeCache.decode(
                  audioContext,
                  source,
                  abort.signal,
                );
                return {
                  sampleRate: buffer.sampleRate,
                  channels: Array.from({ length: buffer.numberOfChannels }, (_, channel) =>
                    buffer.getChannelData(channel),
                  ),
                };
              },
            }
          : {}),
        readback,
        readbackInto: readback,
        present: (time) =>
          pipeline.present(
            createBeautyFrameRequest({
              snapshot,
              project: validated.project,
              composition: validated.composition,
              time,
              ...assignment.case.size,
              antiAliasing: assignment.case.aa,
            }),
            undefined,
            false,
          ),
        complete: () => active.complete(),
        diagnostics: () => structuredClone(active.diagnostics),
        assertHealthy,
        dispose,
      };
    } catch (error) {
      try {
        await dispose();
      } catch (cleanup) {
        throw new Error(`${String(error)}\nPerformance cleanup: ${String(cleanup)}`);
      }
      throw error;
    }
  },
};
