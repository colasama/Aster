import { useEffect, useRef } from "react";
import { AudioDecodeCache } from "../../core/audio-decode-cache";
import type { DecodedPcm } from "../../core/audio-mixer";
import { logger } from "../../core/logger";
import type { FootageSource } from "../../core/types";
import { desktopRenderHost } from "../../desktop/api";
import {
  EMPTY_RENDER_MEDIA_SNAPSHOT,
  hydrateRenderMediaSnapshot,
} from "../../render-queue/render-media-manifest";
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
    let audioAbort: AbortController | undefined;
    const unsubscribe = host.onControl((control) => {
      if (!correlation) return;
      requestedControl = mergeRenderHostControl(requestedControl, control, correlation);
      if (requestedControl) audioAbort?.abort(new DOMException(requestedControl, "AbortError"));
    });

    void (async () => {
      const assignment = await host.take();
      correlation = assignment;
      requestedControl = assignment.initialControl;
      const validated = validateRenderHostAssignment(assignment);
      const mediaLease = await hydrateRenderMediaSnapshot(
        validated.project,
        validated.manifest.renderMediaSnapshot ?? EMPTY_RENDER_MEDIA_SNAPSHOT,
      );
      let renderer: WebGpuRenderer | CanvasFallbackRenderer | undefined;
      let audioRuntime:
        | { cache: AudioDecodeCache; context: OfflineAudioContext; abort: AbortController }
        | undefined;
      try {
        if (stopped) return;
        canvas.width = validated.manifest.width;
        canvas.height = validated.manifest.height;
        renderer = await WebGpuRenderer.create(canvas).catch((error: unknown) => {
          logger.error("render_host", "webgpu_fallback_activated", error);
          return new CanvasFallbackRenderer(canvas);
        });
        if (stopped) return;
        const pipeline = new ProductionBeautyFramePipeline(
          createViewportBeautyFrameBackend(renderer, canvas),
        );
        pipeline.resize(validated.manifest.width, validated.manifest.height);
        audioRuntime = validated.manifest.outputs.some(
          (output) => output.kind === "mp4" && output.includeAudio,
        )
          ? {
              cache: new AudioDecodeCache(),
              context: new OfflineAudioContext(2, 1, 48_000),
              abort: new AbortController(),
            }
          : undefined;
        audioAbort = audioRuntime?.abort;
        const activeAudioRuntime = audioRuntime;
        await runRenderHostFrameLoop({
          assignment: validated,
          pixelFormat: pipeline.pixelFormat,
          ...(activeAudioRuntime
            ? {
                audioDecoder: (source: Extract<FootageSource, { kind: "audio" | "video" }>) =>
                  decodeSourcePcm(
                    activeAudioRuntime.cache,
                    activeAudioRuntime.context,
                    source,
                    activeAudioRuntime.abort.signal,
                  ),
              }
            : {}),
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
      } finally {
        audioRuntime?.abort.abort(new DOMException("RenderHost session ended", "AbortError"));
        audioRuntime?.cache.clear();
        audioAbort = undefined;
        renderer?.dispose();
        mediaLease.dispose();
      }
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

async function decodeSourcePcm(
  cache: AudioDecodeCache,
  context: OfflineAudioContext,
  source: Extract<FootageSource, { kind: "audio" | "video" }>,
  signal?: AbortSignal,
): Promise<DecodedPcm> {
  const buffer = await cache.decode(context, source, signal);
  return {
    sampleRate: buffer.sampleRate,
    channels: Array.from({ length: buffer.numberOfChannels }, (_, channel) =>
      buffer.getChannelData(channel),
    ),
  };
}
