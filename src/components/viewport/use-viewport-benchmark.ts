import type { RefObject } from "react";

import { useEffect } from "react";
import { logger } from "../../core/logger";

import { activeComposition } from "../../core/project/project";
import { resolveGpuMemoryBudget } from "../../core/rendering/gpu-memory-policy";
import type { ExclusiveRenderSessionGuard } from "../../core/rendering/render-session-guard";
import type { RenderSnapshotIdentity } from "../../core/rendering/render-snapshot";

import {
  type GpuBenchmarkRequest,
  runGpuBenchmark,
} from "../../renderer/diagnostics/gpu-benchmark";
import { createNativePreviewBenchmark } from "../../renderer/native-project/preview-benchmark";
import type { NativePreviewView } from "../../renderer/native-project/preview-view";
import { isReferencePreview } from "../../renderer/reference/preview";

import { useEditor } from "../../state/editor-store";

import type { Renderer } from "./viewport-rendering";

const claimedGpuBenchmarkEvents = new WeakSet<Event>();

export function useViewportBenchmark(
  canvasRef: RefObject<HTMLCanvasElement | null>,
  rendererRef: RefObject<Renderer | undefined>,
  renderSessionGuardRef: RefObject<ExclusiveRenderSessionGuard>,
  resize: () => void,
  snapshot: RenderSnapshotIdentity,
  nativePreviewRef: RefObject<NativePreviewView | undefined>,
) {
  const { state } = useEditor();
  useEffect(() => {
    let running = false;
    const runBenchmark = (event: Event) => {
      const request = event as CustomEvent<GpuBenchmarkRequest>;
      if (claimedGpuBenchmarkEvents.has(event)) return;
      const canvas = canvasRef.current;
      const renderer = rendererRef.current;
      const native = nativePreviewRef.current;
      if (
        request.detail.expectedCompositionId &&
        request.detail.expectedCompositionId !== activeComposition(state.project).id
      ) {
        claimedGpuBenchmarkEvents.add(event);
        request.detail.accept();
        request.detail.reject(new Error("Benchmark composition is not ready."));
        return;
      }
      if (!canvas || (!renderer && !native) || running || renderSessionGuardRef.current.active) {
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
      const memoryBudgetMb = resolveGpuMemoryBudget(
        request.detail.memoryBudgetMb ?? state.gpuMemoryBudgetMb,
        (native ?? renderer)?.diagnostics.gpuMemory?.device,
      );
      const webgpu = isReferencePreview(renderer) ? renderer : undefined;
      const previousVisualization = webgpu?.bufferVisualization;
      const backend = native
        ? createNativePreviewBenchmark(native, state.antiAliasing, memoryBudgetMb)
        : renderer && {
            resize: (width: number, height: number) => renderer.resize(width, height),
            render: isReferencePreview(renderer)
              ? renderer.render.bind(renderer)
              : (
                  composition: Parameters<typeof renderer.render>[0],
                  time: number,
                  _identity: RenderSnapshotIdentity,
                  playing?: boolean,
                  project?: Parameters<typeof renderer.render>[3],
                ) => renderer.render(composition, time, playing, project),
            complete: () => renderer.complete(),
          };
      if (!backend) {
        lease.close();
        running = false;
        return;
      }
      void (async () => {
        if (!Number.isFinite(memoryBudgetMb) || memoryBudgetMb <= 0)
          throw new Error("Benchmark memory budget must be positive and finite");
        await native?.beginExclusive();
        try {
          webgpu?.setMemoryBudget(memoryBudgetMb);
          webgpu?.setBufferVisualization("beauty");
          return await runGpuBenchmark(
            backend,
            canvas,
            benchmarkComposition,
            state.project,
            snapshot,
            state.currentTime,
            (native ?? renderer)?.diagnostics.adapter ?? "Unknown",
            native ? "native-preview" : (renderer?.diagnostics.architecture ?? "Unknown"),
            request.detail.sampleFrames,
            request.detail.onProgress,
            request.detail.scenarioNames,
            { antiAliasing: state.antiAliasing, memoryBudgetMb, visualization: "beauty" },
          );
        } finally {
          if (webgpu) {
            webgpu.setMemoryBudget(
              state.gpuMemoryBudgetMb === "auto" ? undefined : state.gpuMemoryBudgetMb,
            );
            if (previousVisualization) webgpu.setBufferVisualization(previousVisualization);
          }
        }
      })()
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
          native?.endExclusive();
          lease.close();
          queueMicrotask(resize);
        });
    };
    window.addEventListener("aster:run-gpu-benchmark", runBenchmark);
    return () => window.removeEventListener("aster:run-gpu-benchmark", runBenchmark);
  }, [
    canvasRef,
    rendererRef,
    nativePreviewRef,
    renderSessionGuardRef,
    resize,
    state.currentTime,
    state.project,
    state.antiAliasing,
    state.gpuMemoryBudgetMb,
    snapshot,
  ]);
}
