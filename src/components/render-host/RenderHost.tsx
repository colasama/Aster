import { useEffect, useRef } from "react";
import { AudioDecodeCache } from "../../core/audio/audio-decode-cache";
import type { DecodedPcm } from "../../core/audio/audio-mixer";
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
} from "../../renderer/compositing/beauty-frame";
import { encodeRawFramePng } from "../../renderer/gpu/raw-frame-png";
import { WebGpuRenderer } from "../../renderer/webgpu-renderer";
import { createProductionRenderHostRenderer, renderHostFailure } from "./render-host-renderer";
import {
  mergeRenderHostControl,
  renderHostCorrelation,
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
    let controlSignal = createSignal();
    let correlation: { jobId: string; leaseId: string } | undefined;
    let audioAbort: AbortController | undefined;
    const unsubscribe = host.onControl((control) => {
      if (!correlation) return;
      const nextControl = mergeRenderHostControl(requestedControl, control, correlation);
      if (nextControl === requestedControl) return;
      requestedControl = nextControl;
      const changed = controlSignal;
      controlSignal = createSignal();
      changed.resolve();
      if (requestedControl === "cancel")
        audioAbort?.abort(new DOMException(requestedControl, "AbortError"));
    });

    void (async () => {
      const assignment = await host.take();
      // The assignment also carries a manifest and resume state. Never spread those fields into a
      // strict terminal-report payload: doing so makes a render failure impossible to persist.
      correlation = renderHostCorrelation(assignment);
      requestedControl = assignment.initialControl;
      const validated = validateRenderHostAssignment(assignment);
      const mediaLease = await hydrateRenderMediaSnapshot(
        validated.project,
        validated.manifest.renderMediaSnapshot ?? EMPTY_RENDER_MEDIA_SNAPSHOT,
      );
      let renderer: WebGpuRenderer | undefined;
      let audioRuntime:
        | { cache: AudioDecodeCache; context: OfflineAudioContext; abort: AbortController }
        | undefined;
      try {
        if (stopped) return;
        canvas.width = validated.manifest.width;
        canvas.height = validated.manifest.height;
        renderer = await createProductionRenderHostRenderer(canvas, WebGpuRenderer.create);
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
          maxInFlightFrames: pipeline.maxConcurrentReadbacks,
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
          waitForControlChange: () => controlSignal.promise,
          renderFrame: (_frame, time) =>
            pipeline.readback(
              createBeautyFrameRequest({
                composition: validated.composition,
                antiAliasing: validated.manifest.antiAliasing,
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
      const failure = renderHostFailure(error);
      try {
        await host.report({
          type: "failed",
          ...correlation,
          error: {
            ...failure,
            correlationId: crypto.randomUUID(),
          },
        });
      } catch (reportError) {
        // Closing the hidden window gives the main process an independent terminal boundary. Its
        // window-close handler fails and retires the lease even if strict report IPC regresses.
        logger.error("render_host", "terminal_report_failed", reportError, correlation);
        window.close();
      }
    });

    return () => {
      stopped = true;
      unsubscribe();
    };
  }, []);

  return <canvas ref={canvasRef} />;
}

function createSignal(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
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
