import { useEffect, useRef } from "react";
import { logger } from "../../core/logger";
import { desktopRenderHost } from "../../desktop/api";
import {
  createBeautyFrameRequest,
  createViewportBeautyFrameBackend,
  ProductionBeautyFramePipeline,
} from "../../renderer/beauty-frame";
import { CanvasFallbackRenderer } from "../../renderer/canvas-fallback";
import { encodeRawFramePng } from "../../renderer/raw-frame-png";
import { WebGpuRenderer } from "../../renderer/webgpu-renderer";
import {
  mergeRenderHostControl,
  runRenderHostFrameLoop,
  validateRenderHostAssignment,
} from "./render-host-session";

/** The hidden Electron renderer entry point. It deliberately has no editor state or visible UI. */
export function RenderHost() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const host = desktopRenderHost();
    let stopped = false;
    let requestedControl: "pause" | "cancel" | undefined;
    let correlation: { jobId: string; leaseId: string } | undefined;
    const unsubscribe = host.onControl((control) => {
      if (!correlation) return;
      requestedControl = mergeRenderHostControl(requestedControl, control, correlation);
    });

    void (async () => {
      const assignment = await host.take();
      correlation = assignment;
      requestedControl = assignment.initialControl;
      const validated = validateRenderHostAssignment(assignment);
      canvas.width = validated.manifest.width;
      canvas.height = validated.manifest.height;
      const renderer = await WebGpuRenderer.create(canvas).catch((error: unknown) => {
        logger.error("render_host", "webgpu_fallback_activated", error);
        return new CanvasFallbackRenderer(canvas);
      });
      if (stopped) return;
      const pipeline = new ProductionBeautyFramePipeline(
        createViewportBeautyFrameBackend(renderer, canvas),
      );
      pipeline.resize(validated.manifest.width, validated.manifest.height);
      await runRenderHostFrameLoop({
        assignment,
        pixelFormat: pipeline.pixelFormat,
        requestedControl: () => requestedControl,
        renderFrame: (_frame, time) =>
          pipeline.readback(
            createBeautyFrameRequest({
              composition: validated.composition,
              project: validated.project,
              time,
              width: validated.manifest.width,
              height: validated.manifest.height,
            }),
            validated.synchronizeVideo,
          ),
        encodePng: async (frame) =>
          (
            await encodeRawFramePng(frame, validated.manifest.width, validated.manifest.height)
          ).arrayBuffer(),
        output: (request) => host.output(request),
        report: (report) => host.report(report),
      });
    })().catch(async (error: unknown) => {
      logger.error("render_host", "session_failed", error, correlation);
      if (!correlation) return;
      await host
        .report({
          type: "failed",
          ...correlation,
          error: {
            code: "render_host_failed",
            message: error instanceof Error ? error.message : String(error),
            correlationId: crypto.randomUUID(),
          },
        })
        .catch(() => undefined);
    });

    return () => {
      stopped = true;
      unsubscribe();
    };
  }, []);

  return <canvas ref={canvasRef} />;
}
