import { evaluateLayerSourceTime } from "../../core/animation/layer-time";
import type { FootageSource, Layer } from "../../core/types";
import {
  type MediaResource,
  mediaResourceRetired,
  mediaTextureExtent,
  reportVideoUploadError,
} from "./media-resource";
import type { TextureUploadBatch } from "./texture-upload-batch";
import type { VideoExternalUploadStatus } from "./video-external-upload";

/** Owns direct-video upload selection and the bounded Canvas2D staging fallback. */
export interface VideoFrameTarget {
  source: string;
  time: number;
  tolerance: number;
}

export class VideoFrameUploader {
  resolveTarget(
    source: string,
    video: HTMLVideoElement,
    layer: Layer,
    footage: FootageSource,
    time: number,
    playing: boolean,
  ): VideoFrameTarget {
    const duration = Number.isFinite(video.duration)
      ? video.duration
      : "duration" in footage
        ? footage.duration
        : layer.outPoint - layer.inPoint;
    const lastTime = Math.max(0, duration - 0.001);
    return {
      source,
      time: videoSeekTime(evaluateLayerSourceTime(layer, time, lastTime), lastTime, playing),
      tolerance: playing ? 0.12 : 1 / 240,
    };
  }

  canUpload(resource: MediaResource): boolean {
    const video = resource.video;
    return Boolean(
      resource.texture &&
        video &&
        video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA &&
        !video.seeking,
    );
  }

  isExact(resource: MediaResource, target?: VideoFrameTarget): boolean {
    if (!this.canUpload(resource)) return false;
    const video = resource.video;
    if (!video || !target || target.source !== resource.source) return false;
    return (
      Math.abs(video.currentTime - target.time) <= target.tolerance &&
      resource.lastUploadedTime !== undefined &&
      Math.abs(resource.lastUploadedTime - target.time) <= target.tolerance
    );
  }

  constructor(readonly uploads: TextureUploadBatch) {}
  copy(resource: MediaResource): void {
    if (mediaResourceRetired(resource)) return;
    const video = resource.video;
    const texture = resource.texture;
    if (
      !video ||
      !texture ||
      video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA ||
      video.seeking ||
      resource.lastUploadedTime === video.currentTime
    )
      return;
    const mediaTime = video.currentTime;
    try {
      const externalUpload = resource.videoExternalUpload;
      if (externalUpload?.copyFrame()) {
        resource.lastUploadedTime = mediaTime;
        resource.uploadErrorReported = false;
        video.dataset.gpuFrame = "direct-external-copy";
        video.dataset.gpuUploadPath = "direct-external-copy";
        delete video.dataset.gpuError;
        return;
      }
      // Do not read back a full frame while the bounded compatibility probe is still running.
      // Its status callback schedules the exact frame through either the direct GPU copy or the
      // conservative staging fallback once the adapter result is known.
      if (externalUpload?.status.mode === "validating") {
        video.dataset.gpuFrame = "external-copy-validation";
        video.dataset.gpuUploadPath = "external-copy-validation";
        return;
      }
      const context = this.ensureFallbackSurface(resource);
      const canvas = resource.videoCanvas;
      if (!context || !canvas) throw new Error("Canvas2D video upload fallback is unavailable");
      context.drawImage(video, 0, 0, canvas.width, canvas.height);
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
      this.uploads.enqueue(texture, pixels.data, canvas.width, canvas.height);
      resource.lastUploadedTime = mediaTime;
      resource.uploadErrorReported = false;
      video.dataset.gpuFrame = "cpu-staging-fallback";
      video.dataset.gpuUploadPath = "cpu-staging-fallback";
      delete video.dataset.gpuError;
    } catch (error) {
      reportVideoUploadError(resource, error);
    }
  }

  ensureFallbackSurface(resource: MediaResource): CanvasRenderingContext2D | undefined {
    const extent = mediaTextureExtent(resource);
    if (!extent) return undefined;
    const [width, height] = extent;
    if (
      resource.videoCanvas?.width === width &&
      resource.videoCanvas.height === height &&
      resource.videoContext
    )
      return resource.videoContext;
    this.releaseFallbackSurface(resource);
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    canvas.setAttribute("aria-hidden", "true");
    const context =
      canvas.getContext("2d", { alpha: false, willReadFrequently: true }) ?? undefined;
    resource.videoCanvas = canvas;
    resource.videoContext = context;
    return context;
  }

  releaseFallbackSurface(resource: MediaResource): void {
    if (resource.videoCanvas) {
      resource.videoCanvas.width = 1;
      resource.videoCanvas.height = 1;
      resource.videoCanvas.remove();
    }
    resource.videoCanvas = undefined;
    resource.videoContext = undefined;
  }

  reportStatus(resource: MediaResource, status: VideoExternalUploadStatus): void {
    const video = resource.video;
    if (!video) return;
    video.dataset.gpuUploadCapability = status.mode;
    video.dataset.gpuUploadDiagnostic = status.reason;
    video.dataset.gpuUploadPath =
      status.mode === "direct" ? "direct-external-copy" : "cpu-staging-fallback";
  }
}

const EXACT_SEEK_BIAS_SECONDS = 1e-4;

/**
 * A seek that lands exactly on a frame boundary can decode the previous frame, because the
 * media element rounds its timeline to coarser timestamps. Exact renders bias forward by a
 * sub-millisecond amount, which selects the intended frame for any practical frame rate.
 */
export function videoSeekTime(sourceTime: number, lastTime: number, playing: boolean): number {
  return playing ? sourceTime : Math.min(lastTime, sourceTime + EXACT_SEEK_BIAS_SECONDS);
}
