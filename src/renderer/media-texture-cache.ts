import { AsyncWorkPool } from "../core/async-work-pool";
import { configurePreviewVideoAudio } from "../core/audio-preview";
import { evaluateLayerTransform } from "../core/expressions";
import { sourceLocator } from "../core/footage-source";
import { evaluateLayerSourceTime } from "../core/layer-time";
import { projectFontRevision } from "../core/project-font-runtime";
import { clampTextAnimationTime, countAnimatedTextCharacters } from "../core/text-animator";
import type { FootageSource, Layer } from "../core/types";
import {
  ImageSequenceFrameCache,
  type ResolvedSequenceFrame,
  resolveImageSequenceFrame,
} from "../importers/image-sequence-runtime";
import {
  mediaImportRuntime,
  type RuntimeImageSequence,
  type RuntimePsdLayer,
  type RuntimeSequenceFile,
  type RuntimeSvgSource,
} from "../importers/media-import-runtime";
import { decodeRasterImage } from "../importers/raster-image-decoder";
import {
  computeSvgRasterTarget,
  rasterizeSvgToImageBitmap,
  SvgRasterCache,
  svgTransformedRasterSize,
} from "../importers/svg-raster-cache";
import {
  destroyMediaResource,
  type MediaResource,
  mediaTextureBytes,
  mediaTextureExtent,
  reportVideoUploadError,
  sweepMediaResources,
} from "./media-resource";
import type { TextMotionBlurPlan } from "./text-motion-blur-plan";
import {
  TextMotionBlurRasterCache,
  type TextMotionBlurRasterFrameStats,
} from "./text-motion-blur-raster-cache";
import { rasterizeTextLayer, textRasterResolutionScale } from "./text-rasterizer";
import { TextureUploadBatch } from "./texture-upload-batch";
import { VideoExternalUpload, type VideoExternalUploadStatus } from "./video-external-upload";

const MAX_MEDIA_TEXTURE_DIMENSION = 8_192;
const MAX_MEDIA_TEXTURE_BYTES = 256 * 1024 * 1024;

interface PendingFrameResource {
  source: string;
  promise: Promise<void>;
}

interface VideoFrameTarget {
  source: string;
  time: number;
  tolerance: number;
}

/** Owns decoded media, text rasters, and the staging upload queue used by the renderer. */
export class MediaTextureCache {
  readonly #device: GPUDevice;
  readonly #layout: GPUBindGroupLayout;
  readonly #sampler: GPUSampler;
  readonly #invalidate: () => void;
  readonly #resources = new Map<string, MediaResource>();
  readonly #pendingFrameResources = new Map<string, PendingFrameResource>();
  readonly #frameResourceErrors = new Map<string, { source: string; error: Error }>();
  readonly #videoFrameTargets = new Map<string, VideoFrameTarget>();
  readonly #videoUploadListeners = new Set<(resource: MediaResource) => void>();
  readonly #decodePool = new AsyncWorkPool(4);
  readonly #uploads: TextureUploadBatch;
  #textMotionBlur?: TextMotionBlurRasterCache;
  readonly #sequenceFrames = new ImageSequenceFrameCache<RuntimeSequenceFile, ImageBitmap>({
    decode: (file) => this.#decodeImage(file.url, file.name, file.type),
    estimateBytes: (bitmap) => bitmap.width * bitmap.height * 4,
    dispose: (bitmap) => bitmap.close(),
    maxEntries: 24,
    maxBytes: 384 * 1024 * 1024,
  });
  readonly #svgRasters = new SvgRasterCache<ImageBitmap>({
    rasterize: rasterizeSvgToImageBitmap,
    dispose: (bitmap) => bitmap.close(),
    maxEntries: 12,
    maxBytes: 256 * 1024 * 1024,
  });
  #destroyed = false;

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
    return (
      mediaTextureBytes(this.#resources) +
      this.#uploads.capacityBytes +
      (this.#textMotionBlur?.estimatedBytes ?? 0)
    );
  }

  get hasPendingFrameResources(): boolean {
    if (this.#pendingFrameResources.size > 0) return true;
    for (const [instanceId, resource] of this.#resources)
      if (resource.kind === "video" && !this.#videoFrameIsExact(instanceId, resource)) return true;
    return false;
  }

  get textMotionBlurFrameStats(): TextMotionBlurRasterFrameStats {
    return (
      this.#textMotionBlur?.frameStats ?? {
        drawCount: 0,
        passCount: 0,
        transientTextureCount: 0,
        resolutionScaleReductionCount: 0,
      }
    );
  }

  destroy(): void {
    if (this.#destroyed) return;
    this.#destroyed = true;
    for (const resource of this.#resources.values()) destroyMediaResource(resource);
    this.#resources.clear();
    this.#pendingFrameResources.clear();
    this.#frameResourceErrors.clear();
    this.#videoFrameTargets.clear();
    this.#sequenceFrames.clear();
    this.#svgRasters.clear();
    this.#uploads.destroy();
    this.#textMotionBlur?.destroy();
    this.#textMotionBlur = undefined;
  }

  bindGroup(instanceId: string): GPUBindGroup | undefined {
    return this.#resources.get(instanceId)?.bindGroup;
  }

  beginFrame(): void {
    this.#textMotionBlur?.beginFrame();
  }

  flush(encoder: GPUCommandEncoder): void {
    this.#uploads.flush(encoder);
    this.#textMotionBlur?.encode(encoder);
  }

  submitted(): void {
    this.#textMotionBlur?.submitted();
  }

  abortFrame(): void {
    this.#textMotionBlur?.abortSubmission();
  }

  sweep(activeInstanceIds: ReadonlySet<string>): void {
    sweepMediaResources(this.#resources, activeInstanceIds);
    for (const instanceId of this.#pendingFrameResources.keys())
      if (!activeInstanceIds.has(instanceId)) this.#pendingFrameResources.delete(instanceId);
    for (const instanceId of this.#frameResourceErrors.keys())
      if (!activeInstanceIds.has(instanceId)) this.#frameResourceErrors.delete(instanceId);
    for (const instanceId of this.#videoFrameTargets.keys())
      if (!activeInstanceIds.has(instanceId)) this.#videoFrameTargets.delete(instanceId);
    this.#textMotionBlur?.sweep(activeInstanceIds);
  }

  async waitForVideoFrames(timeoutMs = 10_000): Promise<void> {
    const resources = [...this.#resources.values()].filter(
      (resource) => resource.kind === "video" && resource.video,
    );
    await Promise.all(resources.map((resource) => this.#waitForVideoFrame(resource, timeoutMs)));
  }

  /** Waits only for the current generation of every exact-frame media resource. */
  async waitForFrameResources(timeoutMs = 10_000, signal?: AbortSignal): Promise<void> {
    const started = performance.now();
    while (true) {
      if (signal?.aborted) throw abortError(signal.reason);
      const pending = [...this.#pendingFrameResources.values()];
      if (pending.length > 0)
        await waitWithTimeout(
          Promise.all(pending.map((resource) => resource.promise)).then(() => undefined),
          remainingTimeout(started, timeoutMs),
          signal,
          "Timed out waiting for exact image, SVG, or image-sequence resources",
        );
      if (this.#pendingFrameResources.size > 0) continue;
      const failure = this.#frameResourceErrors.values().next().value as
        | { source: string; error: Error }
        | undefined;
      if (failure) throw failure.error;
      await waitWithTimeout(
        this.waitForVideoFrames(remainingTimeout(started, timeoutMs)),
        remainingTimeout(started, timeoutMs),
        signal,
        "Timed out waiting for exact video resources",
      );
      if (this.#pendingFrameResources.size === 0) return;
    }
  }

  prepareMedia(
    layer: Layer,
    footage: FootageSource,
    time: number,
    playing: boolean,
    instanceId: string,
    resolutionScale = 1,
  ): void {
    if (this.#destroyed) throw new Error("Media texture cache is destroyed");
    const source = sourceLocator(footage);
    if (!source) return;
    if (layer.kind !== "video") this.#videoFrameTargets.delete(instanceId);
    const runtime = mediaImportRuntime.get(footage.id);
    if (runtime?.kind === "psd") {
      this.#pendingFrameResources.delete(instanceId);
      this.#preparePsd(runtime, layer, footage, instanceId, source);
      return;
    }
    if (runtime?.kind === "svg") {
      this.#prepareSvg(runtime, layer, footage, time, instanceId, source, resolutionScale);
      return;
    }
    if (runtime?.kind === "imageSequence") {
      this.#prepareImageSequence(runtime, layer, footage, time, instanceId, source);
      return;
    }
    const existing = this.#resources.get(instanceId);
    if (existing?.source === source && existing.kind === layer.kind) {
      this.#frameResourceErrors.delete(instanceId);
      if (existing.kind === "video")
        this.#updateVideo(existing, layer, footage, time, playing, instanceId);
      return;
    }
    this.#pendingFrameResources.delete(instanceId);
    this.#frameResourceErrors.delete(instanceId);
    destroyMediaResource(existing);
    const resource: MediaResource = { source, kind: layer.kind === "video" ? "video" : "image" };
    this.#resources.set(instanceId, resource);
    if (resource.kind === "video") {
      this.#prepareVideo(resource, layer, footage, time, playing, instanceId);
      return;
    }
    const pending = fetch(source)
      .then((response) => {
        if (!response.ok) throw new Error(`Media request failed with HTTP ${response.status}`);
        return response.blob();
      })
      .then((blob) =>
        this.#decodePool.run(() =>
          decodeRasterImage(blob, { name: footage.name, mimeType: footage.mimeType }),
        ),
      )
      .then((bitmap) => {
        if (this.#destroyed) {
          bitmap.close();
          return;
        }
        this.#installBitmap(resource, bitmap, layer, footage, instanceId);
      })
      .catch((error: unknown) => {
        if (this.#destroyed) return;
        if (this.#resources.get(instanceId) === resource) this.#resources.delete(instanceId);
        mediaImportRuntime.reportError(footage.id, error);
        throw error;
      });
    this.#trackPending(instanceId, source, pending);
  }

  #preparePsd(
    runtime: RuntimePsdLayer,
    layer: Layer,
    footage: FootageSource,
    instanceId: string,
    locator: string,
  ): void {
    const [cropX, cropY, width, height] = runtime.crop;
    const source = `${locator}|${runtime.documentIdentity}|${cropX},${cropY},${width},${height}`;
    const existing = this.#resources.get(instanceId);
    if (existing?.kind === "image" && existing.source === source) {
      this.#frameResourceErrors.delete(instanceId);
      mediaImportRuntime.clearError(footage.id);
      return;
    }
    destroyMediaResource(existing);
    this.#resources.delete(instanceId);
    const maximumDimension = Math.min(
      MAX_MEDIA_TEXTURE_DIMENSION,
      this.#device.limits.maxTextureDimension2D,
    );
    if (
      width < 1 ||
      height < 1 ||
      width > maximumDimension ||
      height > maximumDimension ||
      width * height * 4 > MAX_MEDIA_TEXTURE_BYTES ||
      cropX < 0 ||
      cropY < 0 ||
      cropX + width > runtime.decodedWidth ||
      cropY + height > runtime.decodedHeight
    ) {
      const error = new Error(
        "PSD layer crop exceeds the available GPU texture or decoded pixel bounds",
      );
      mediaImportRuntime.reportError(footage.id, error);
      this.#frameResourceErrors.set(instanceId, { source, error });
      return;
    }
    const requiredBytes = runtime.decodedWidth * runtime.decodedHeight * 4;
    if (runtime.pixels.byteLength < requiredBytes) {
      const error = new Error("PSD decoded pixel plane is truncated");
      mediaImportRuntime.reportError(footage.id, error);
      this.#frameResourceErrors.set(instanceId, { source, error });
      return;
    }
    const resource: MediaResource = { source, kind: "image" };
    this.#resources.set(instanceId, resource);
    const texture = this.#device.createTexture({
      label: `Imported PSD layer · ${footage.name}`,
      size: [width, height],
      format: "rgba8unorm-srgb",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    this.#device.queue.writeTexture(
      { texture },
      runtime.pixels,
      {
        offset: (cropY * runtime.decodedWidth + cropX) * 4,
        bytesPerRow: runtime.decodedWidth * 4,
        rowsPerImage: runtime.decodedHeight,
      },
      [width, height],
    );
    resource.texture = texture;
    resource.textureBytes = width * height * 4;
    resource.bindGroup = this.#createBindGroup(texture, `Imported PSD resources · ${layer.id}`);
    mediaImportRuntime.clearError(footage.id);
    this.#frameResourceErrors.delete(instanceId);
    this.#invalidate();
  }

  #prepareSvg(
    runtime: RuntimeSvgSource,
    layer: Layer,
    footage: FootageSource,
    time: number,
    instanceId: string,
    locator: string,
    resolutionScale: number,
  ): void {
    const transform = evaluateLayerTransform(layer, time);
    const rasterSize = svgTransformedRasterSize(layer.size, transform.scale);
    const target = svgPreviewRasterTarget(
      rasterSize.displayWidth,
      rasterSize.displayHeight,
      resolutionScale,
      Math.min(MAX_MEDIA_TEXTURE_DIMENSION, this.#device.limits.maxTextureDimension2D),
    );
    const source = `${locator}|${target.width}x${target.height}`;
    const existing = this.#resources.get(instanceId);
    if (existing?.kind === "image" && existing.source === source) {
      this.#frameResourceErrors.delete(instanceId);
      return;
    }
    if (this.#pendingFrameResources.get(instanceId)?.source === source) return;
    this.#installCachedBitmapWhenReady(
      source,
      this.#svgRasters.get(footage.contentIdentity, runtime.parsed, target),
      layer,
      footage,
      instanceId,
    );
  }

  #prepareImageSequence(
    runtime: RuntimeImageSequence,
    layer: Layer,
    footage: FootageSource,
    time: number,
    instanceId: string,
    locator: string,
  ): void {
    let resolved: ResolvedSequenceFrame<RuntimeSequenceFile>;
    try {
      const duration =
        ((runtime.selection.endFrame - runtime.selection.startFrame + 1) *
          runtime.frameRate.denominator) /
        runtime.frameRate.numerator;
      const mediaTime = evaluateLayerSourceTime(layer, time, duration);
      resolved = resolveImageSequenceFrame(runtime.selection, mediaTime, runtime.frameRate, {
        loop: runtime.loop,
        missingFramePolicy: runtime.missingFramePolicy,
      });
    } catch (error) {
      mediaImportRuntime.reportError(footage.id, error);
      this.#frameResourceErrors.set(instanceId, {
        source: `${locator}|sequence-error|${time}`,
        error: asError(error),
      });
      destroyMediaResource(this.#resources.get(instanceId));
      this.#resources.delete(instanceId);
      return;
    }
    const frame = { frame: resolved.actualFrame, file: resolved.file };
    const source = `${locator}|${resolved.actualFrame}|${resolved.file.url}`;
    const existing = this.#resources.get(instanceId);
    if (existing?.kind === "image" && existing.source === source) {
      this.#frameResourceErrors.delete(instanceId);
      return;
    }
    if (this.#pendingFrameResources.get(instanceId)?.source !== source)
      this.#installCachedBitmapWhenReady(
        source,
        this.#sequenceFrames.get(frame),
        layer,
        footage,
        instanceId,
      );
    void this.#sequenceFrames
      .preload(runtime.selection.frames, resolved.actualFrame, runtime.loop ? 2 : 3, 2)
      .catch(() => undefined);
  }

  async #decodeImage(url: string, name: string, mimeType: string): Promise<ImageBitmap> {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Media request failed with HTTP ${response.status}`);
    return decodeRasterImage(await response.blob(), { name, mimeType });
  }

  #installCachedBitmapWhenReady(
    source: string,
    pending: Promise<ImageBitmap>,
    layer: Layer,
    footage: FootageSource,
    instanceId: string,
  ): void {
    const installation = pending.then(
      (bitmap) => {
        if (this.#destroyed) return;
        if (this.#pendingFrameResources.get(instanceId)?.source !== source) return;
        const previous = this.#resources.get(instanceId);
        const resource: MediaResource = { source, kind: "image" };
        this.#resources.set(instanceId, resource);
        try {
          this.#installBitmap(resource, bitmap, layer, footage, instanceId, false);
          destroyMediaResource(previous);
          mediaImportRuntime.clearError(footage.id);
        } catch (error) {
          destroyMediaResource(resource);
          if (previous) this.#resources.set(instanceId, previous);
          else this.#resources.delete(instanceId);
          mediaImportRuntime.reportError(footage.id, error);
          throw error;
        }
      },
      (error: unknown) => {
        if (this.#destroyed) return;
        if (this.#pendingFrameResources.get(instanceId)?.source !== source) return;
        mediaImportRuntime.reportError(footage.id, error);
        throw error;
      },
    );
    this.#trackPending(instanceId, source, installation);
  }

  #trackPending(instanceId: string, source: string, task: Promise<void>): void {
    const pending: PendingFrameResource = { source, promise: Promise.resolve() };
    this.#frameResourceErrors.delete(instanceId);
    pending.promise = task
      .catch((error: unknown) => {
        if (this.#destroyed) return;
        if (this.#pendingFrameResources.get(instanceId) === pending)
          this.#frameResourceErrors.set(instanceId, { source, error: asError(error) });
        throw error;
      })
      .finally(() => {
        if (this.#pendingFrameResources.get(instanceId) === pending)
          this.#pendingFrameResources.delete(instanceId);
      });
    this.#pendingFrameResources.set(instanceId, pending);
    void pending.promise.catch(() => undefined);
  }

  prepareText(
    layer: Layer,
    instanceId: string,
    localTime: number,
    frameRate: number,
    resolutionScale = 1,
    motionBlur?: TextMotionBlurPlan,
  ): void {
    if (this.#destroyed) throw new Error("Media texture cache is destroyed");
    const rasterScale = textRasterResolutionScale(resolutionScale);
    if (motionBlur) {
      this.#textMotionBlur ??= new TextMotionBlurRasterCache(
        this.#device,
        this.#layout,
        this.#sampler,
      );
      const temporal = this.#textMotionBlur.prepare(layer, instanceId, motionBlur, resolutionScale);
      if (temporal) {
        const existing = this.#resources.get(instanceId);
        this.#frameResourceErrors.delete(instanceId);
        if (
          existing?.kind === "text" &&
          existing.source === temporal.source &&
          existing.bindGroup === temporal.bindGroup
        )
          return;
        destroyMediaResource(existing);
        this.#resources.set(instanceId, {
          source: temporal.source,
          kind: "text",
          bindGroup: temporal.bindGroup,
          textureBytes: temporal.textureBytes,
        });
        return;
      }
    }
    this.#textMotionBlur?.delete(instanceId);
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
      projectFontRevision(),
      layer.textAnimator,
      sampledAnimationTime,
      rasterScale,
    ]);
    const existing = this.#resources.get(instanceId);
    if (existing?.kind === "text" && existing.source === source) {
      this.#frameResourceErrors.delete(instanceId);
      return;
    }
    this.#frameResourceErrors.delete(instanceId);
    const raster = rasterizeTextLayer(
      layer,
      Math.min(MAX_MEDIA_TEXTURE_DIMENSION, this.#device.limits.maxTextureDimension2D),
      sampledAnimationTime,
      rasterScale,
    );
    if (
      existing?.kind === "text" &&
      existing.texture &&
      existing.textureWidth === raster.width &&
      existing.textureHeight === raster.height
    ) {
      existing.source = source;
      this.#uploads.enqueue(existing.texture, raster.pixels, raster.width, raster.height);
      return;
    }
    destroyMediaResource(existing);
    const resource: MediaResource = {
      source,
      kind: "text",
      textureWidth: raster.width,
      textureHeight: raster.height,
    };
    this.#resources.set(instanceId, resource);
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
    footage: FootageSource,
    instanceId: string,
    closeBitmap = true,
  ): void {
    if (this.#destroyed) {
      if (closeBitmap) bitmap.close();
      return;
    }
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
      if (closeBitmap) bitmap.close();
      throw new Error("Decoded media exceeds the GPU texture limits");
    }
    const texture = this.#device.createTexture({
      label: `Imported image · ${footage.name}`,
      size: [bitmap.width, bitmap.height],
      format: "rgba8unorm-srgb",
      // WebGPU external-image copies require both COPY_DST and RENDER_ATTACHMENT. Keeping the
      // decoded bitmap on this path avoids an otherwise unnecessary Canvas2D readback/staging
      // upload for stills and image-sequence frames.
      usage:
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.COPY_DST |
        GPUTextureUsage.RENDER_ATTACHMENT,
    });
    this.#device.queue.copyExternalImageToTexture({ source: bitmap }, { texture }, [
      bitmap.width,
      bitmap.height,
    ]);
    if (closeBitmap) bitmap.close();
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
    footage: FootageSource,
    time: number,
    playing: boolean,
    instanceId: string,
  ): void {
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
    this.#videoFrameTargets.set(
      instanceId,
      this.#resolveVideoFrameTarget(resource.source, video, layer, footage, time, playing),
    );
    document.body.append(video);
    const prepareTexture = () => {
      if (this.#resources.get(instanceId) !== resource || resource.texture) return;
      video.dataset.decoderState = "ready";
      const width = Math.max(1, video.videoWidth || ("width" in footage ? footage.width : 1));
      const height = Math.max(1, video.videoHeight || ("height" in footage ? footage.height : 1));
      if (!this.#validVideoSize(width, height)) {
        video.dataset.decoderState = "error";
        video.dataset.decoderError = "decoded video exceeds the GPU texture limits";
        this.#frameResourceErrors.set(instanceId, {
          source: resource.source,
          error: new Error(video.dataset.decoderError),
        });
        destroyMediaResource(resource);
        this.#resources.delete(instanceId);
        return;
      }
      resource.texture = this.#device.createTexture({
        label: `Hardware-decoded video · ${footage.name}`,
        size: [width, height],
        format: "rgba8unorm-srgb",
        usage:
          GPUTextureUsage.TEXTURE_BINDING |
          GPUTextureUsage.COPY_DST |
          GPUTextureUsage.RENDER_ATTACHMENT,
      });
      resource.textureBytes = width * height * 4;
      resource.textureWidth = width;
      resource.textureHeight = height;
      this.#ensureVideoFallbackSurface(resource);
      resource.bindGroup = this.#createBindGroup(
        resource.texture,
        `Video texture resources · ${layer.id}`,
      );
      resource.videoExternalUpload = new VideoExternalUpload(
        this.#device,
        video,
        resource.texture,
        width,
        height,
        {
          onStatus: (status) => {
            if (this.#resources.get(instanceId) !== resource) return;
            this.#reportVideoUploadStatus(resource, status);
            if (status.mode === "direct") this.#releaseVideoFallbackSurface(resource);
            if (status.mode !== "validating") this.#copyVideoFrame(resource);
            for (const notify of this.#videoUploadListeners) notify(resource);
            this.#invalidate();
          },
        },
      );
      resource.videoExternalUpload.start();
      this.#updateVideo(resource, layer, footage, time, playing, instanceId);
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
        this.#frameResourceErrors.set(instanceId, {
          source: resource.source,
          error: new Error(video.dataset.decoderError),
        });
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

  #waitForVideoFrame(resource: MediaResource, timeoutMs: number): Promise<void> {
    const video = resource.video;
    if (!video) return Promise.resolve();
    return new Promise((resolve, reject) => {
      let settled = false;
      const cleanup = () => {
        clearTimeout(timeout);
        video.removeEventListener("loadeddata", check);
        video.removeEventListener("seeked", check);
        video.removeEventListener("canplay", check);
        video.removeEventListener("error", check);
        this.#videoUploadListeners.delete(uploadChanged);
      };
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (error) reject(error);
        else resolve();
      };
      const check = () => {
        if (video.error) {
          finish(new Error(video.error.message || "Video decode failed during export"));
          return;
        }
        if (this.#videoFrameCanUpload(resource)) {
          this.#copyVideoFrame(resource);
          const instanceId = video.dataset.asterLayerId;
          if (instanceId && this.#videoFrameIsExact(instanceId, resource)) finish();
        }
      };
      const timeout = setTimeout(
        () => finish(new Error("Timed out waiting for an exact video frame during export")),
        timeoutMs,
      );
      const uploadChanged = (changed: MediaResource) => {
        if (changed === resource) check();
      };
      this.#videoUploadListeners.add(uploadChanged);
      video.addEventListener("loadeddata", check);
      video.addEventListener("seeked", check);
      video.addEventListener("canplay", check);
      video.addEventListener("error", check);
      check();
    });
  }

  #updateVideo(
    resource: MediaResource,
    layer: Layer,
    footage: FootageSource,
    time: number,
    playing: boolean,
    instanceId: string,
  ): void {
    const video = resource.video;
    if (!video) return;
    configurePreviewVideoAudio(video, layer);
    const target = this.#resolveVideoFrameTarget(
      resource.source,
      video,
      layer,
      footage,
      time,
      playing,
    );
    this.#videoFrameTargets.set(instanceId, target);
    if (Math.abs(video.currentTime - target.time) > target.tolerance)
      video.currentTime = target.time;
    if (playing && video.paused) void video.play().catch(() => undefined);
    else if (!playing && !video.paused) video.pause();
    this.#copyVideoFrame(resource);
  }

  #resolveVideoFrameTarget(
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
    return {
      source,
      time: evaluateLayerSourceTime(layer, time, Math.max(0, duration - 0.001)),
      tolerance: playing ? 0.12 : 1 / 240,
    };
  }

  #videoFrameCanUpload(resource: MediaResource): boolean {
    const video = resource.video;
    return Boolean(
      resource.texture &&
        video &&
        video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA &&
        !video.seeking,
    );
  }

  #videoFrameIsExact(instanceId: string, resource: MediaResource): boolean {
    if (!this.#videoFrameCanUpload(resource)) return false;
    const video = resource.video;
    const target = this.#videoFrameTargets.get(instanceId);
    if (!video || !target || target.source !== resource.source) return false;
    return (
      Math.abs(video.currentTime - target.time) <= target.tolerance &&
      resource.lastUploadedTime !== undefined &&
      Math.abs(resource.lastUploadedTime - target.time) <= target.tolerance
    );
  }

  #copyVideoFrame(resource: MediaResource): void {
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
      const context = this.#ensureVideoFallbackSurface(resource);
      const canvas = resource.videoCanvas;
      if (!context || !canvas) throw new Error("Canvas2D video upload fallback is unavailable");
      context.drawImage(video, 0, 0, canvas.width, canvas.height);
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
      this.#uploads.enqueue(texture, pixels.data, canvas.width, canvas.height);
      resource.lastUploadedTime = mediaTime;
      resource.uploadErrorReported = false;
      video.dataset.gpuFrame = "cpu-staging-fallback";
      video.dataset.gpuUploadPath = "cpu-staging-fallback";
      delete video.dataset.gpuError;
    } catch (error) {
      reportVideoUploadError(resource, error);
    }
  }

  #ensureVideoFallbackSurface(resource: MediaResource): CanvasRenderingContext2D | undefined {
    const extent = mediaTextureExtent(resource);
    if (!extent) return undefined;
    const [width, height] = extent;
    if (
      resource.videoCanvas?.width === width &&
      resource.videoCanvas.height === height &&
      resource.videoContext
    )
      return resource.videoContext;
    this.#releaseVideoFallbackSurface(resource);
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

  #releaseVideoFallbackSurface(resource: MediaResource): void {
    if (resource.videoCanvas) {
      resource.videoCanvas.width = 1;
      resource.videoCanvas.height = 1;
      resource.videoCanvas.remove();
    }
    resource.videoCanvas = undefined;
    resource.videoContext = undefined;
  }

  #reportVideoUploadStatus(resource: MediaResource, status: VideoExternalUploadStatus): void {
    const video = resource.video;
    if (!video) return;
    video.dataset.gpuUploadCapability = status.mode;
    video.dataset.gpuUploadDiagnostic = status.reason;
    video.dataset.gpuUploadPath =
      status.mode === "direct" ? "direct-external-copy" : "cpu-staging-fallback";
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

function bucketSvgTarget(displayWidth: number, displayHeight: number, maximumDimension: number) {
  const largest = Math.max(1, displayWidth, displayHeight);
  const bucketedLargest = Math.min(
    maximumDimension,
    1.25 ** Math.ceil(Math.log(largest) / Math.log(1.25)),
  );
  const scale = bucketedLargest / largest;
  return computeSvgRasterTarget({
    displayWidth: displayWidth * scale,
    displayHeight: displayHeight * scale,
    resolutionScale: 1,
    maxTextureDimension: maximumDimension,
    maxPixels: MAX_MEDIA_TEXTURE_BYTES / 4,
  });
}

export function svgPreviewRasterTarget(
  displayWidth: number,
  displayHeight: number,
  resolutionScale: number,
  maximumDimension: number,
) {
  const scale = Number.isFinite(resolutionScale) ? Math.max(1, resolutionScale) : 1;
  return bucketSvgTarget(displayWidth * scale, displayHeight * scale, maximumDimension);
}

function remainingTimeout(started: number, timeoutMs: number): number {
  const bounded = Number.isFinite(timeoutMs) ? Math.max(1, timeoutMs) : 10_000;
  return Math.max(0, bounded - (performance.now() - started));
}

function waitWithTimeout<T>(
  task: Promise<T>,
  timeoutMs: number,
  signal: AbortSignal | undefined,
  message: string,
): Promise<T> {
  if (signal?.aborted) return Promise.reject(abortError(signal.reason));
  if (timeoutMs <= 0) return Promise.reject(new Error(message));
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (error: unknown, value?: T) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
      if (error) reject(error);
      else resolve(value as T);
    };
    const onAbort = () => finish(abortError(signal?.reason));
    const timeout = setTimeout(() => finish(new Error(message)), timeoutMs);
    signal?.addEventListener("abort", onAbort, { once: true });
    task.then((value) => finish(undefined, value), finish);
  });
}

function abortError(reason: unknown): Error {
  const error = new Error(typeof reason === "string" ? reason : "Frame resource wait was aborted");
  error.name = "AbortError";
  return error;
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
