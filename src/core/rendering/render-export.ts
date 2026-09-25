import {
  cancelMp4Export,
  finishMp4Export,
  invoke,
  isDesktopRuntime,
  open,
  save,
  startMp4Export,
  writeMp4Audio,
  writeMp4Frame,
} from "../../desktop/api";
import {
  captureRenderMediaManifest,
  hydrateRenderMediaSnapshot,
  parseRenderMediaManifest,
  type RenderMediaHydrationLease,
  serializeRenderMediaManifest,
} from "../../render-queue/render-media-manifest";
import type { RawFramePixelFormat, RawVideoFrame } from "../../renderer/gpu/frame-readback";
import {
  alignedAudioFrameCount,
  decodeAudibleSources,
  EXPORT_AUDIO_SAMPLE_RATE,
  streamCompositionAudio,
} from "../audio/audio-export";
import { sharedAudioPlaybackEngine } from "../audio/audio-playback-engine";
import { logger } from "../logger";
import type { Composition, Project } from "../types";

export interface FrameRenderSession {
  renderFrame: (time: number) => Promise<Blob>;
  renderRawFrame: (time: number) => Promise<RawVideoFrame>;
  rawPixelFormat: RawFramePixelFormat;
  width: number;
  height: number;
  maxInFlightFrames: number;
  videoSynchronization: "none" | "seek-and-await";
  close: () => void;
}

export interface FrameRenderSessionOptions {
  project?: Project;
  maxDimension?: number;
}

export interface FrameRenderSessionOpenRequest {
  options: FrameRenderSessionOptions;
  resolve: (session: FrameRenderSession) => void;
  reject: (error: Error) => void;
}

export interface RenderSequenceProgress {
  current: number;
  total: number;
}

export interface RenderSequenceResult {
  directory: string;
  frames: number;
  cancelled: boolean;
}

export interface RenderMp4Result {
  outputPath: string;
  frames: number;
  cancelled: boolean;
  encoder?: "h264_nvenc" | "libx264";
  bytesWritten?: number;
  elapsedMs?: number;
}

export function nativeSequenceExportAvailable(): boolean {
  return isDesktopRuntime();
}

export function nativeMp4ExportAvailable(): boolean {
  return isDesktopRuntime();
}

export async function openFrameRenderSession(
  options: FrameRenderSessionOptions = {},
): Promise<FrameRenderSession> {
  return new Promise<FrameRenderSession>((resolve, reject) => {
    let handled = false;
    window.dispatchEvent(
      new CustomEvent<FrameRenderSessionOpenRequest>("aster:open-render-session", {
        detail: {
          options,
          resolve: (session) => {
            handled = true;
            resolve(session);
          },
          reject: (error) => {
            handled = true;
            reject(error);
          },
        },
      }),
    );
    queueMicrotask(() => {
      if (!handled) reject(new Error("Renderer did not handle the frame session request"));
    });
  });
}

export async function renderSingleFrame(time: number): Promise<Blob> {
  const startedAt = performance.now();
  const session = await openFrameRenderSession();
  try {
    const frame = await session.renderFrame(time);
    logger.info("export", "single_frame_completed", {
      durationMs: performance.now() - startedAt,
    });
    return frame;
  } finally {
    session.close();
  }
}

export async function renderPngSequence(
  project: Project,
  composition: Composition,
  onProgress: (progress: RenderSequenceProgress) => void,
  cancelled: () => boolean,
): Promise<RenderSequenceResult | undefined> {
  if (!nativeSequenceExportAvailable()) {
    throw new Error("PNG sequence export is available in the native Aster application");
  }
  const directory = await open({
    directory: true,
    multiple: false,
    title: "Choose a PNG sequence output folder",
  });
  if (typeof directory !== "string") return undefined;
  const foreground = await captureForegroundRenderProjectSnapshot(project, composition);
  ({ project, composition } = foreground);
  const frameCount = Math.max(
    1,
    Math.ceil(
      (composition.duration * composition.frameRate.numerator) / composition.frameRate.denominator,
    ),
  );
  let session: FrameRenderSession;
  try {
    session = await openFrameRenderSession({ project });
  } catch (error) {
    foreground.mediaLease.dispose();
    throw error;
  }
  const startedAt = performance.now();
  logger.info("export", "png_sequence_started", {
    frameCount,
    width: composition.width,
    height: composition.height,
  });
  let completed = 0;
  try {
    for (let frame = 0; frame < frameCount; frame += 1) {
      if (cancelled()) break;
      onProgress({ current: frame, total: frameCount });
      const blob = await session.renderFrame(frameTimeAtIndex(frame, composition.frameRate));
      const fileName = `frame_${String(frame + 1).padStart(6, "0")}.png`;
      await invoke("save_render_frame", {
        directory,
        fileName,
        data: await blobToBase64(blob),
      });
      completed += 1;
    }
  } catch (error) {
    logger.error("export", "png_sequence_failed", error, { completed, frameCount });
    throw error;
  } finally {
    try {
      session.close();
    } finally {
      foreground.mediaLease.dispose();
    }
  }
  onProgress({ current: completed, total: frameCount });
  logger.info(
    "export",
    completed < frameCount ? "png_sequence_cancelled" : "png_sequence_completed",
    {
      completed,
      frameCount,
      durationMs: performance.now() - startedAt,
    },
  );
  return { directory, frames: completed, cancelled: completed < frameCount };
}

export async function renderMp4(
  project: Project,
  composition: Composition,
  onProgress: (progress: RenderSequenceProgress) => void,
  cancelled: () => boolean,
): Promise<RenderMp4Result | undefined> {
  if (!nativeMp4ExportAvailable())
    throw new Error("MP4 export is available in the native Aster application");
  if (composition.width % 2 !== 0 || composition.height % 2 !== 0)
    throw new Error("H.264 MP4 export requires even composition dimensions");
  const outputPath = await save({
    title: "Export H.264 MP4",
    defaultPath: "aster-export.mp4",
    filters: [{ name: "MPEG-4 Video", extensions: ["mp4"] }],
  });
  if (!outputPath) return undefined;
  const foreground = await captureForegroundRenderProjectSnapshot(project, composition);
  ({ project, composition } = foreground);
  const frameCount = Math.max(
    1,
    Math.ceil(
      (composition.duration * composition.frameRate.numerator) / composition.frameRate.denominator,
    ),
  );
  let decodedAudio: Awaited<ReturnType<typeof decodeAudibleSources>>;
  try {
    decodedAudio = await decodeAudibleSources(project, composition, (source) =>
      sharedAudioPlaybackEngine.decodedPcm(source),
    );
  } catch (error) {
    foreground.mediaLease.dispose();
    throw error;
  }
  const audioFrameCount =
    decodedAudio.size > 0
      ? alignedAudioFrameCount(frameCount, composition.frameRate, EXPORT_AUDIO_SAMPLE_RATE)
      : 0;
  let session: FrameRenderSession;
  try {
    session = await openFrameRenderSession({ project });
  } catch (error) {
    foreground.mediaLease.dispose();
    throw error;
  }
  const startedAt = performance.now();
  logger.info("export", "mp4_pipeline_started", {
    frameCount,
    width: composition.width,
    height: composition.height,
    pixelFormat: session.rawPixelFormat,
    maxInFlightFrames: session.maxInFlightFrames,
    videoSynchronization: session.videoSynchronization,
  });
  let jobId: string | undefined;
  let completed = 0;
  try {
    const started = await startMp4Export({
      outputPath,
      width: composition.width,
      height: composition.height,
      frameRateNumerator: composition.frameRate.numerator,
      frameRateDenominator: composition.frameRate.denominator,
      frameCount,
      pixelFormat: session.rawPixelFormat,
      videoBitrateBps: 20_000_000,
      audio:
        audioFrameCount > 0
          ? {
              sampleRate: EXPORT_AUDIO_SAMPLE_RATE,
              channels: 2,
              frameCount: audioFrameCount,
            }
          : undefined,
    });
    jobId = started.jobId;
    let pipelineAborted = false;
    const pipelineCancelled = () => pipelineAborted || cancelled();
    const videoPipeline = streamFramePipeline({
      frameCount,
      maxInFlight: session.maxInFlightFrames,
      cancelled: pipelineCancelled,
      render: (frame) => session.renderRawFrame(frameTimeAtIndex(frame, composition.frameRate)),
      write: async (frame) => {
        if (frame.pixelFormat !== session.rawPixelFormat)
          throw new Error("Renderer changed MP4 pixel format during export");
        await writeMp4Frame(started.jobId, frame.pixels);
      },
      onProgress,
    }).catch((error) => {
      pipelineAborted = true;
      throw error;
    });
    const audioPipeline =
      audioFrameCount > 0
        ? streamCompositionAudio(
            project,
            composition,
            decodedAudio,
            audioFrameCount,
            async (samples) => writeMp4Audio(started.jobId, samples.buffer as ArrayBuffer),
            pipelineCancelled,
            EXPORT_AUDIO_SAMPLE_RATE,
          ).catch((error) => {
            pipelineAborted = true;
            throw error;
          })
        : Promise.resolve(0);
    const videoResult = await settleExportStage(videoPipeline);
    // FFmpeg drains the auxiliary audio input at mux pace, so a PCM write can stay blocked
    // after cancellation. Tear the session down before draining the audio pipeline so its
    // pending write rejects instead of deadlocking the export.
    if ((videoResult.status === "rejected" || videoResult.value < frameCount) && jobId) {
      await cancelMp4Export(jobId).catch(() => undefined);
      jobId = undefined;
    }
    const audioResult = await settleExportStage(audioPipeline);
    if (videoResult.status === "rejected") throw videoResult.reason;
    // A rejection after the session was cancelled is the released backpressure write above.
    if (audioResult.status === "rejected" && (jobId !== undefined || !cancelled()))
      throw audioResult.reason;
    completed = videoResult.value;
    const completedAudio = audioResult.status === "fulfilled" ? audioResult.value : 0;
    if (completed < frameCount || (audioFrameCount > 0 && completedAudio < audioFrameCount)) {
      if (jobId) {
        await cancelMp4Export(jobId);
        jobId = undefined;
      }
      logger.info("export", "mp4_pipeline_cancelled", {
        completed,
        frameCount,
        durationMs: performance.now() - startedAt,
      });
      return { outputPath, frames: completed, cancelled: true, encoder: started.encoder };
    }
    const report = await finishMp4Export(started.jobId);
    jobId = undefined;
    logger.info("export", "mp4_pipeline_completed", {
      frameCount: report.frameCount,
      audioFrameCount: report.audioFrameCount,
      encoder: report.encoder,
      bytesWritten: report.bytesWritten,
      durationMs: performance.now() - startedAt,
    });
    return {
      outputPath: report.outputPath,
      frames: report.frameCount,
      cancelled: false,
      encoder: report.encoder,
      bytesWritten: report.bytesWritten,
      elapsedMs: report.elapsedMs,
    };
  } catch (error) {
    if (jobId) await cancelMp4Export(jobId).catch(() => undefined);
    logger.error("export", "mp4_pipeline_failed", error, { completed, frameCount });
    throw error;
  } finally {
    try {
      session.close();
    } finally {
      foreground.mediaLease.dispose();
    }
  }
}

/** Captures one immutable document and makes the requested composition authoritative for a job. */
export function captureRenderProjectSnapshot(
  project: Project,
  composition: Composition,
): { project: Project; composition: Composition } {
  // Production export is an in-process runtime operation. Keep ephemeral media locators in the
  // immutable capture; the persistence sanitizer deliberately removes them and would make linked
  // still/video/audio sources go offline before the first exported frame.
  const snapshot = structuredClone(project);
  const capturedComposition = snapshot.compositions.find(
    (candidate) => candidate.id === composition.id,
  );
  if (!capturedComposition)
    throw new Error("Render composition is not present in the captured project snapshot");
  snapshot.activeCompositionId = capturedComposition.id;
  return { project: snapshot, composition: capturedComposition };
}

export async function captureForegroundRenderProjectSnapshot(
  project: Project,
  composition: Composition,
): Promise<{
  project: Project;
  composition: Composition;
  mediaLease: RenderMediaHydrationLease;
}> {
  // Start Blob/asset reads and clone registry-owned bytes before the first await. The editor may
  // continue mutating after this call returns a promise, but the export observes only this capture.
  const mediaCapture = captureRenderMediaManifest(project, composition.id);
  const captured = captureRenderProjectSnapshot(project, composition);
  const mediaManifest = parseRenderMediaManifest(await serializeRenderMediaManifest(mediaCapture));
  const remappedIds = new Map<string, string>();
  for (const entry of mediaManifest.entries) {
    const temporaryId = `render-${crypto.randomUUID()}`;
    remappedIds.set(entry.sourceId, temporaryId);
    entry.sourceId = temporaryId;
  }
  for (const source of captured.project.sources) {
    const temporaryId = remappedIds.get(source.id);
    if (temporaryId) source.id = temporaryId;
  }
  for (const candidate of captured.project.compositions)
    for (const layer of candidate.layers) {
      const temporaryId = layer.sourceId ? remappedIds.get(layer.sourceId) : undefined;
      if (temporaryId) layer.sourceId = temporaryId;
    }
  for (const [sourceId, temporaryId] of remappedIds) {
    const folderId = captured.project.itemFolderIds[sourceId];
    if (folderId) captured.project.itemFolderIds[temporaryId] = folderId;
    delete captured.project.itemFolderIds[sourceId];
  }
  const mediaLease = await hydrateRenderMediaSnapshot(
    captured.project,
    JSON.stringify(mediaManifest),
  );
  return { ...captured, mediaLease };
}

/** Converts an integer output frame index directly through the rational rate without accumulation. */
export function frameTimeAtIndex(
  frame: number,
  frameRate: { numerator: number; denominator: number },
): number {
  if (!Number.isSafeInteger(frame) || frame < 0)
    throw new Error("Output frame index must be a non-negative safe integer");
  if (
    !Number.isSafeInteger(frameRate.numerator) ||
    !Number.isSafeInteger(frameRate.denominator) ||
    frameRate.numerator < 1 ||
    frameRate.denominator < 1
  )
    throw new Error("Output frame rate must be a positive rational number");
  return (frame * frameRate.denominator) / frameRate.numerator;
}

interface FramePipelineOptions<Frame> {
  frameCount: number;
  maxInFlight: number;
  cancelled: () => boolean;
  render: (frame: number) => Promise<Frame>;
  write: (frame: Frame, index: number) => Promise<void>;
  beforeFrame?: () => Promise<void>;
  onProgress: (progress: RenderSequenceProgress) => void | Promise<void>;
}

export async function streamFramePipeline<Frame>(
  options: FramePipelineOptions<Frame>,
): Promise<number> {
  const depth = Number.isFinite(options.maxInFlight)
    ? Math.max(1, Math.min(3, Math.floor(options.maxInFlight)))
    : 1;
  const pending = new Map<number, Promise<Frame>>();
  let nextRender = 0;
  let nextWrite = 0;
  let completed = 0;
  const fill = () => {
    while (nextRender < options.frameCount && pending.size < depth && !options.cancelled()) {
      const index = nextRender;
      const work = options.render(index);
      void work.catch(() => undefined);
      pending.set(index, work);
      nextRender += 1;
    }
  };
  await options.onProgress({ current: 0, total: options.frameCount });
  try {
    while (nextWrite < options.frameCount && !options.cancelled()) {
      await options.beforeFrame?.();
      if (options.cancelled()) break;
      fill();
      const frame = await pending.get(nextWrite);
      pending.delete(nextWrite);
      if (frame === undefined || options.cancelled()) break;
      // Controls may arrive during GPU mapping. Hold completed frames without submitting more.
      await options.beforeFrame?.();
      if (options.cancelled()) break;
      fill();
      await options.write(frame, nextWrite);
      completed += 1;
      nextWrite += 1;
      await options.onProgress({ current: completed, total: options.frameCount });
    }
    return completed;
  } finally {
    await Promise.allSettled(pending.values());
  }
}

function settleExportStage(promise: Promise<number>): Promise<PromiseSettledResult<number>> {
  return promise.then(
    (value): PromiseSettledResult<number> => ({ status: "fulfilled", value }),
    (reason): PromiseSettledResult<number> => ({ status: "rejected", reason }),
  );
}

async function blobToBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const chunks: string[] = [];
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + 0x8000)));
  }
  return btoa(chunks.join(""));
}
