import {
  cancelMp4Export,
  finishMp4Export,
  invoke,
  isDesktopRuntime,
  open,
  save,
  startMp4Export,
  writeMp4Frame,
} from "../desktop/api";
import type { RawFramePixelFormat, RawVideoFrame } from "../renderer/frame-readback";
import { logger } from "./logger";
import type { Composition } from "./types";

export interface FrameRenderSession {
  renderFrame: (time: number) => Promise<Blob>;
  renderRawFrame: (time: number) => Promise<RawVideoFrame>;
  rawPixelFormat: RawFramePixelFormat;
  maxInFlightFrames: number;
  close: () => void;
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

export async function openFrameRenderSession(): Promise<FrameRenderSession> {
  const session = await new Promise<FrameRenderSession | undefined>((resolve) => {
    window.dispatchEvent(new CustomEvent("aster:open-render-session", { detail: { resolve } }));
  });
  if (!session) throw new Error("Renderer did not open a frame session");
  return session;
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
  const frameRate = composition.frameRate.numerator / composition.frameRate.denominator;
  const frameCount = Math.max(1, Math.ceil(composition.duration * frameRate));
  const session = await openFrameRenderSession();
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
      const blob = await session.renderFrame(frame / frameRate);
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
    session.close();
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
  const frameCount = Math.max(
    1,
    Math.ceil(
      (composition.duration * composition.frameRate.numerator) / composition.frameRate.denominator,
    ),
  );
  const session = await openFrameRenderSession();
  const startedAt = performance.now();
  logger.info("export", "mp4_pipeline_started", {
    frameCount,
    width: composition.width,
    height: composition.height,
    pixelFormat: session.rawPixelFormat,
    maxInFlightFrames: session.maxInFlightFrames,
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
    });
    jobId = started.jobId;
    completed = await streamFramePipeline({
      frameCount,
      maxInFlight: session.maxInFlightFrames,
      cancelled,
      render: (frame) =>
        session.renderRawFrame(
          (frame * composition.frameRate.denominator) / composition.frameRate.numerator,
        ),
      write: async (frame) => {
        if (frame.pixelFormat !== session.rawPixelFormat)
          throw new Error("Renderer changed MP4 pixel format during export");
        await writeMp4Frame(started.jobId, frame.pixels);
      },
      onProgress,
    });
    if (completed < frameCount) {
      await cancelMp4Export(started.jobId);
      jobId = undefined;
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
    session.close();
  }
}

interface FramePipelineOptions<Frame> {
  frameCount: number;
  maxInFlight: number;
  cancelled: () => boolean;
  render: (frame: number) => Promise<Frame>;
  write: (frame: Frame, index: number) => Promise<void>;
  onProgress: (progress: RenderSequenceProgress) => void;
}

export async function streamFramePipeline<Frame>(
  options: FramePipelineOptions<Frame>,
): Promise<number> {
  const depth = Math.max(1, Math.min(3, Math.floor(options.maxInFlight)));
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
  options.onProgress({ current: 0, total: options.frameCount });
  try {
    fill();
    while (nextWrite < options.frameCount && !options.cancelled()) {
      const frame = await pending.get(nextWrite);
      pending.delete(nextWrite);
      if (frame === undefined || options.cancelled()) break;
      fill();
      await options.write(frame, nextWrite);
      completed += 1;
      nextWrite += 1;
      options.onProgress({ current: completed, total: options.frameCount });
    }
    return completed;
  } finally {
    await Promise.allSettled(pending.values());
  }
}

async function blobToBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const chunks: string[] = [];
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + 0x8000)));
  }
  return btoa(chunks.join(""));
}
