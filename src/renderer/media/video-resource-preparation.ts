import { configurePreviewVideoAudio } from "../../core/audio/audio-preview";
import type { FootageSource, Layer } from "../../core/types";
import { hiddenMediaStyle } from "./media-loading";
import type { MediaResource } from "./media-resource";
import { VideoExternalUpload } from "./video-external-upload";
import type { VideoFrameUploader } from "./video-frame-uploader";

export interface VideoResourcePreparation {
  resource: MediaResource;
  layer: Layer;
  footage: FootageSource;
  instanceId: string;
  device: GPUDevice;
  uploader: VideoFrameUploader;
  isCurrent(): boolean;
  validSize(width: number, height: number): boolean;
  createBinding(texture: GPUTexture, label: string): GPUBindGroup;
  updateTarget(): void;
  initializeTarget(): void;
  fail(error: Error): void;
  uploadChanged(): void;
  invalidate(): void;
}

/** Own the browser decoder and its validated upload path for preview and retained TS export. */
export function prepareBrowserVideo(options: VideoResourcePreparation): void {
  const { resource, layer, footage, instanceId } = options;
  const video = document.createElement("video");
  video.preload = "auto";
  video.playsInline = true;
  // The asset scheme is a separate origin from the packaged file document. CORS mode must be
  // selected before assigning src so its decoded frames remain origin-clean for the bounded
  // validation probe and the emergency Canvas2D fallback.
  video.crossOrigin = "anonymous";
  configurePreviewVideoAudio(video, layer);
  video.dataset.asterLayerId = instanceId;
  video.dataset.decoderState = "loading";
  video.setAttribute("aria-hidden", "true");
  Object.assign(video.style, hiddenMediaStyle(0));
  video.src = resource.source;
  resource.video = video;
  options.initializeTarget();
  document.body.append(video);
  const prepareTexture = () => {
    if (!options.isCurrent() || resource.texture) return;
    video.dataset.decoderState = "ready";
    const width = Math.max(1, video.videoWidth || ("width" in footage ? footage.width : 1));
    const height = Math.max(1, video.videoHeight || ("height" in footage ? footage.height : 1));
    if (!options.validSize(width, height)) {
      video.dataset.decoderState = "error";
      video.dataset.decoderError = "decoded video exceeds the GPU texture limits";
      options.fail(new Error(video.dataset.decoderError));
      return;
    }
    resource.texture = options.device.createTexture({
      label: `Hardware-decoded video · ${footage.name}`,
      size: [width, height],
      format: "rgba8unorm-srgb",
      usage:
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.COPY_DST |
        GPUTextureUsage.COPY_SRC |
        GPUTextureUsage.RENDER_ATTACHMENT,
    });
    resource.textureBytes = width * height * 4;
    resource.textureWidth = width;
    resource.textureHeight = height;
    options.uploader.ensureFallbackSurface(resource);
    resource.bindGroup = options.createBinding(
      resource.texture,
      `Video texture resources · ${layer.id}`,
    );
    resource.videoExternalUpload = new VideoExternalUpload(
      options.device,
      video,
      resource.texture,
      width,
      height,
      {
        onStatus: (status) => {
          if (!options.isCurrent()) return;
          options.uploader.reportStatus(resource, status);
          if (status.mode === "direct") options.uploader.releaseFallbackSurface(resource);
          if (status.mode !== "validating") options.uploader.copy(resource);
          options.uploadChanged();
          options.invalidate();
        },
      },
    );
    resource.videoExternalUpload.start();
    options.updateTarget();
    options.invalidate();
  };
  video.addEventListener("loadeddata", prepareTexture, { once: true });
  video.addEventListener("seeked", () => {
    video.dataset.decoderState = "seeked";
    options.uploader.copy(resource);
    options.invalidate();
  });
  video.addEventListener("error", () => {
    video.dataset.decoderState = "error";
    video.dataset.decoderError = video.error?.message ?? "decode failed";
    if (options.isCurrent()) {
      options.fail(new Error(video.dataset.decoderError));
      options.invalidate();
    }
  });
  video.load();
}
