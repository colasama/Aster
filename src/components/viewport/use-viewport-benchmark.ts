import type { RefObject } from "react";

import { useEffect } from "react";
import { logger } from "../../core/logger";

import { activeComposition } from "../../core/project/project";
import type { ExclusiveRenderSessionGuard } from "../../core/rendering/render-session-guard";

import {
  type GpuBenchmarkRequest,
  runGpuBenchmark,
} from "../../renderer/diagnostics/gpu-benchmark";

import { useEditor } from "../../state/editor-store";

import type { Renderer } from "./viewport-rendering";

const claimedGpuBenchmarkEvents = new WeakSet<Event>();

export function useViewportBenchmark(
  canvasRef: RefObject<HTMLCanvasElement | null>,
  rendererRef: RefObject<Renderer | undefined>,
  renderSessionGuardRef: RefObject<ExclusiveRenderSessionGuard>,
  resize: () => void,
) {
  const { state } = useEditor();
  useEffect(() => {
    let running = false;
    const runBenchmark = (event: Event) => {
      const request = event as CustomEvent<GpuBenchmarkRequest>;
      if (claimedGpuBenchmarkEvents.has(event)) return;
      const canvas = canvasRef.current;
      const renderer = rendererRef.current;
      if (!canvas || !renderer || running || renderSessionGuardRef.current.active) {
        queueMicrotask(() => {
          if (claimedGpuBenchmarkEvents.has(event)) return;
          claimedGpuBenchmarkEvents.add(event);
          request.detail.accept();
          request.detail.reject(new Error("The GPU renderer is not ready for benchmarking."));
        });
        return;
      }
      claimedGpuBenchmarkEvents.add(event);
      request.detail.accept();
      const lease = renderSessionGuardRef.current.acquire(() => undefined);
      running = true;
      const benchmarkStartedAt = performance.now();
      const benchmarkComposition = activeComposition(state.project);
      logger.info("gpu_benchmark", "started", { sampleFrames: request.detail.sampleFrames });
      void runGpuBenchmark(
        renderer,
        canvas,
        benchmarkComposition,
        state.project,
        state.currentTime,
        renderer.diagnostics.adapter,
        renderer.diagnostics.architecture,
        request.detail.sampleFrames,
        request.detail.onProgress,
      )
        .then((report) => {
          logger.info("gpu_benchmark", "completed", {
            sampleFrames: request.detail.sampleFrames,
            durationMs: performance.now() - benchmarkStartedAt,
          });
          request.detail.resolve(report);
        })
        .catch((error: unknown) => {
          logger.error("gpu_benchmark", "failed", error, {
            sampleFrames: request.detail.sampleFrames,
            durationMs: performance.now() - benchmarkStartedAt,
          });
          request.detail.reject(error);
        })
        .finally(() => {
          running = false;
          lease.close();
          queueMicrotask(resize);
        });
    };
    window.addEventListener("aster:run-gpu-benchmark", runBenchmark);
    return () => window.removeEventListener("aster:run-gpu-benchmark", runBenchmark);
  }, [canvasRef, rendererRef, renderSessionGuardRef, resize, state.currentTime, state.project]);
}
