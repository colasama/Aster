import { AsyncWorkPool } from "../core/async-work-pool";
import { configurePreviewVideoAudio } from "../core/audio-preview";
import { evaluateLayerSourceTime } from "../core/layer-time";
import { clampTextAnimationTime, countAnimatedTextCharacters } from "../core/text-animator";
import type { Layer } from "../core/types";
import {
  destroyMediaResource,
  type MediaResource,
  mediaTextureBytes,
  reportVideoUploadError,
  sweepMediaResources,
} from "./media-resource";
import { rasterizeTextLayer } from "./text-rasterizer";
import { TextureUploadBatch } from "./texture-upload-batch";

const MAX_MEDIA_TEXTURE_DIMENSION = 8_192;
const MAX_MEDIA_TEXTURE_BYTES = 256 * 1024 * 1024;

/** Owns decoded media, text rasters, and the staging upload queue used by the renderer. */
export class MediaTextureCache {
  readonly #device: GPUDevice;
  readonly #layout: GPUBindGroupLayout;
  readonly #sampler: GPUSampler;
  readonly #invalidate: () => void;
  readonly #resources = new Map<string, MediaResource>();
  readonly #decodePool = new AsyncWorkPool(4);
  readonly #uploads: TextureUploadBatch;

  constructor(
    device: GPUDevice,
    layout: GPUBindGroupLayout,
    sampler: GPUSampler,
    invalidate: () => void,
  ) {
    this.#device = device;
    this.#layout = layout;
    this.#sampler = sampler;
    this.#invalidate = invalidate;
    this.#uploads = new TextureUploadBatch(device);
  }

  get estimatedBytes(): number {
    return mediaTextureBytes(this.#resources) + this.#uploads.capacityBytes;
  }

  bindGroup(instanceId: string): GPUBindGroup | undefined {
    return this.#resources.get(instanceId)?.bindGroup;
  }

  flush(encoder: GPUCommandEncoder): void {
    this.#uploads.flush(encoder);
  }

  sweep(activeInstanceIds: ReadonlySet<string>): void {
    sweepMediaResources(this.#resources, activeInstanceIds);
  }

  prepareMedia(layer: Layer, time: number, playing: boolean, instanceId: string): void {
    const source = layer.asset?.dataUrl ?? layer.asset?.runtimeUrl;
    if (!source) return;
    const existing = this.#resources.get(instanceId);
    if (existing?.source === source && existing.kind === layer.kind) {
      if (existing.kind === "video") this.#updateVideo(existing, layer, time, playing);
      return;
    }
    destroyMediaResource(existing);
    const resource: MediaResource = { source, kind: layer.kind === "video" ? "video" : "image" };
    this.#resources.set(instanceId, resource);
    if (resource.kind === "video") {
      this.#prepareVideo(resource, layer, time, playing, instanceId);
      return;
    }
    void fetch(source)
      .then((response) => {
        if (!response.ok) throw new Error(`Media request failed with HTTP ${response.status}`);
        return response.blob();
      })
      .then((blob) => this.#decodePool.run(() => createImageBitmap(blob)))
      .then((bitmap) => this.#installBitmap(resource, bitmap, layer, instanceId))
      .catch(() => {
        if (this.#resources.get(instanceId) === resource) this.#resources.delete(instanceId);
      });
  }

  prepareText(layer: Layer, instanceId: string, localTime: number, frameRate: number): void {
    const characterCount = countAnimatedTextCharacters(layer.text ?? layer.name);
    const animationTime = clampTextAnimationTime(layer.textAnimator, localTime, characterCount);
    const sampleRate = Number.isFinite(frameRate) ? Math.max(1, Math.min(240, frameRate)) : 60;
    const sampledAnimationTime =
      animationTime === undefined ? undefined : Math.round(animationTime * sampleRate) / sampleRate;
    const source = JSON.stringify([
      layer.text,
      layer.name,
      layer.color,
      layer.size,
      layer.textStyle,
      layer.textAnimator,
      sampledAnimationTime,
    ]);
    const existing = this.#resources.get(instanceId);
    if (existing?.kind === "text" && existing.source === source) return;
    destroyMediaResource(existing);
    const resource: MediaResource = { source, kind: "text" };
    this.#resources.set(instanceId, resource);
    const raster = rasterizeTextLayer(
      layer,
      Math.min(4096, this.#device.limits.maxTextureDimension2D),
      sampledAnimationTime,
    );
    const texture = this.#device.createTexture({
      label: `GPU text cache · ${layer.name}`,
      size: [raster.width, raster.height],
      format: "rgba8unorm-srgb",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    this.#uploads.enqueue(texture, raster.pixels, raster.width, raster.height);
    resource.texture = texture;
    resource.textureBytes = raster.width * raster.height * 4;
    resource.bindGroup = this.#createBindGroup(texture, `GPU text resources · ${layer.id}`);
  }

  #installBitmap(
    resource: MediaResource,
    bitmap: ImageBitmap,
    layer: Layer,
    instanceId: string,
  ): void {
    const maximumDimension = Math.min(
      MAX_MEDIA_TEXTURE_DIMENSION,
      this.#device.limits.maxTextureDimension2D,
    );
    const textureBytes = bitmap.width * bitmap.height * 4;
    if (
      bitmap.width < 1 ||
      bitmap.height < 1 ||
      bitmap.width > maximumDimension ||
      bitmap.height > maximumDimension ||
      textureBytes > MAX_MEDIA_TEXTURE_BYTES
    ) {
      bitmap.close();
      throw new Error("Decoded media exceeds the GPU texture limits");
    }
    const texture = this.#device.createTexture({
      label: `Imported image · ${layer.asset?.name ?? layer.name}`,
      size: [bitmap.width, bitmap.height],
      format: "rgba8unorm-srgb",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    this.#device.queue.copyExternalImageToTexture({ source: bitmap }, { texture }, [
      bitmap.width,
      bitmap.height,
    ]);
    bitmap.close();
    if (this.#resources.get(instanceId) !== resource) {
      texture.destroy();
      return;
    }
    resource.texture = texture;
    resource.textureBytes = textureBytes;
    resource.bindGroup = this.#createBindGroup(texture, `Imported image resources · ${layer.id}`);
    this.#invalidate();
  }

  #createBindGroup(texture: GPUTexture, label: string): GPUBindGroup {
    return this.#device.createBindGroup({
      label,
      layout: this.#layout,
      entries: [
        { binding: 0, resource: texture.createView() },
        { binding: 1, resource: this.#sampler },
      ],
    });
  }

  #prepareVideo(
    resource: MediaResource,
    layer: Layer,
    time: number,
    playing: boolean,
    instanceId: string,
  ): void {
    const video = document.createElement("video");
    video.preload = "auto";
    video.playsInline = true;
    configurePreviewVideoAudio(video, layer);
    video.dataset.asterLayerId = instanceId;
    video.dataset.decoderState = "loading";
    video.setAttribute("aria-hidden", "true");
    Object.assign(video.style, hiddenMediaStyle(0));
    video.src = resource.source;
    resource.video = video;
    document.body.append(video);
    const prepareTexture = () => {
      if (this.#resources.get(instanceId) !== resource || resource.texture) return;
      video.dataset.decoderState = "ready";
      const width = Math.max(1, video.videoWidth || layer.asset?.width || 1);
      const height = Math.max(1, video.videoHeight || layer.asset?.height || 1);
      if (!this.#validVideoSize(width, height)) {
        video.dataset.decoderState = "error";
        video.dataset.decoderError = "decoded video exceeds the GPU texture limits";
        destroyMediaResource(resource);
        this.#resources.delete(instanceId);
        return;
      }
      resource.texture = this.#device.createTexture({
        label: `Hardware-decoded video · ${layer.asset?.name ?? layer.name}`,
        size: [width, height],
        format: "rgba8unorm-srgb",
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
      });
      resource.textureBytes = width * height * 4;
      resource.videoCanvas = document.createElement("canvas");
      resource.videoCanvas.width = width;
      resource.videoCanvas.height = height;
      resource.videoCanvas.setAttribute("aria-hidden", "true");
      Object.assign(resource.videoCanvas.style, hiddenMediaStyle(1));
      document.body.append(resource.videoCanvas);
      resource.videoContext =
        resource.videoCanvas.getContext("2d", { alpha: false, willReadFrequently: true }) ??
        undefined;
      resource.bindGroup = this.#createBindGroup(
        resource.texture,
        `Video texture resources · ${layer.id}`,
      );
      this.#updateVideo(resource, layer, time, playing);
      this.#invalidate();
    };
    video.addEventListener("loadeddata", prepareTexture, { once: true });
    video.addEventListener("seeked", () => {
      video.dataset.decoderState = "seeked";
      this.#copyVideoFrame(resource);
      this.#invalidate();
    });
    video.addEventListener("error", () => {
      video.dataset.decoderState = "error";
      video.dataset.decoderError = video.error?.message ?? "decode failed";
      if (this.#resources.get(instanceId) === resource) {
        destroyMediaResource(resource);
        this.#resources.delete(instanceId);
      }
    });
    video.load();
  }

  #validVideoSize(width: number, height: number): boolean {
    const maximumDimension = Math.min(
      MAX_MEDIA_TEXTURE_DIMENSION,
      this.#device.limits.maxTextureDimension2D,
    );
    return (
      width <= maximumDimension &&
      height <= maximumDimension &&
      width * height * 4 <= MAX_MEDIA_TEXTURE_BYTES
    );
  }

  #updateVideo(resource: MediaResource, layer: Layer, time: number, playing: boolean): void {
    const video = resource.video;
    if (!video) return;
    configurePreviewVideoAudio(video, layer);
    const duration = Number.isFinite(video.duration)
      ? video.duration
      : (layer.asset?.duration ?? layer.outPoint - layer.inPoint);
    const mediaTime = evaluateLayerSourceTime(layer, time, Math.max(0, duration - 0.001));
    const tolerance = playing ? 0.12 : 1 / 240;
    if (Math.abs(video.currentTime - mediaTime) > tolerance) video.currentTime = mediaTime;
    if (playing && video.paused) void video.play().catch(() => undefined);
    else if (!playing && !video.paused) video.pause();
    this.#copyVideoFrame(resource);
  }

  #copyVideoFrame(resource: MediaResource): void {
    const video = resource.video;
    const texture = resource.texture;
    if (
      !video ||
      !texture ||
      !resource.videoCanvas ||
      !resource.videoContext ||
      video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA ||
      resource.lastUploadedTime === video.currentTime
    )
      return;
    const mediaTime = video.currentTime;
    try {
      resource.videoContext.drawImage(
        video,
        0,
        0,
        resource.videoCanvas.width,
        resource.videoCanvas.height,
      );
      const pixels = resource.videoContext.getImageData(
        0,
        0,
        resource.videoCanvas.width,
        resource.videoCanvas.height,
      );
      this.#uploads.enqueue(
        texture,
        pixels.data,
        resource.videoCanvas.width,
        resource.videoCanvas.height,
      );
      resource.lastUploadedTime = mediaTime;
      resource.uploadErrorReported = false;
      video.dataset.gpuFrame = "uploaded";
      delete video.dataset.gpuError;
    } catch (error) {
      reportVideoUploadError(resource, error);
    }
  }
}

function hiddenMediaStyle(top: number): Partial<CSSStyleDeclaration> {
  return {
    height: "1px",
    left: "0",
    opacity: "0.001",
    pointerEvents: "none",
    position: "fixed",
    top: `${top}px`,
    width: "1px",
  };
}
