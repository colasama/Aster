import { evaluateLayerTransform } from "../core/animation/expressions";
import { evaluateLayerSourceTime } from "../core/animation/layer-time";
import { configurePreviewVideoAudio } from "../core/audio/audio-preview";
import { solidRenderColor, solidRenderSize } from "../core/layers/solid-layer";
import { sourceForLayer, sourceLocator } from "../core/media/footage-source";
import { flattenSceneLayers } from "../core/scene/scene-evaluation";
import type {
  Composition,
  FootageSource,
  GpuDiagnostics,
  Layer,
  Project,
  RendererMetrics,
} from "../core/types";
import { resolveImageSequenceFrame } from "../importers/image-sequence-runtime";
import {
  mediaImportRuntime,
  type RuntimePsdLayer,
  type RuntimeSvgSource,
} from "../importers/media-import-runtime";
import { decodeRasterImage, type RasterImageIdentity } from "../importers/raster-image-decoder";
import {
  computeSvgRasterTarget,
  svgMarkupAtRasterSize,
  svgTransformedRasterSize,
} from "../importers/svg-raster-cache";
import { isTiffSource } from "../importers/tiff-source";
import { drawTextLayer } from "./text/text-rasterizer";

interface CanvasMediaResource {
  source: string;
  element: HTMLCanvasElement | HTMLImageElement | HTMLVideoElement;
  revoke?: () => void;
}

interface PendingCanvasResource {
  source: string;
  promise: Promise<void>;
}

interface CanvasRenderRequest {
  composition: Composition;
  time: number;
  playing: boolean;
  project?: Project;
  selectedLayerId?: string;
}

export class CanvasFallbackRenderer {
  readonly diagnostics: GpuDiagnostics = {
    available: false,
    adapter: "Canvas 2D fallback",
    architecture: "cpu",
    description: "WebGPU unavailable — compatibility rendering active",
    maxTextureSize: 0,
    timestampQueries: false,
  };
  readonly #context: CanvasRenderingContext2D;
  readonly #mediaResources = new Map<string, CanvasMediaResource>();
  readonly #pendingMediaResources = new Map<string, PendingCanvasResource>();
  readonly #mediaResourceErrors = new Map<string, { source: string; error: Error }>();
  #lastRender?: CanvasRenderRequest;
  #width = 1;
  #height = 1;
  #disposed = false;

  constructor(canvas: HTMLCanvasElement) {
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Canvas rendering is unavailable");
    this.#context = context;
  }

  resize(width: number, height: number): void {
    this.#assertActive();
    this.#width = width;
    this.#height = height;
  }

  get outputWidth(): number {
    return this.#width;
  }

  get outputHeight(): number {
    return this.#height;
  }

  render(
    composition: Composition,
    time: number,
    playing = false,
    project?: Project,
    _selectedLayerId?: string,
  ): RendererMetrics {
    this.#assertActive();
    this.#lastRender = {
      composition,
      time,
      playing,
      project,
      selectedLayerId: _selectedLayerId,
    };
    const started = performance.now();
    const context = this.#context;
    context.clearRect(0, 0, this.#width, this.#height);
    const scale = this.#width / composition.width;
    const activeMedia = new Set<string>();
    const sceneLayers = flattenSceneLayers(composition, project, time);
    if (sceneLayers.some((scene) => scene.precompositionSurface || scene.layer.threeDimensional))
      throw new Error("Nested composition and 3D rendering require WebGPU");
    let drawCalls = 0;
    for (const scene of sceneLayers.reverse()) {
      const { layer, transform } = scene;
      if (
        layer.kind === "camera" ||
        layer.kind === "generator" ||
        layer.kind === "light" ||
        layer.kind === "adjustment" ||
        layer.kind === "null" ||
        layer.kind === "audio"
      )
        continue;
      drawCalls += 1;
      const resolvedColor = solidRenderColor(layer);
      const resolvedSize = solidRenderSize(layer);
      const media = this.#prepareMedia(
        layer,
        sourceForLayer(project, layer),
        scene.localTime,
        playing,
        scene.instanceId,
      );
      if (media) activeMedia.add(scene.instanceId);
      context.save();
      context.globalCompositeOperation = canvasBlendMode(layer.blendMode);
      context.translate(transform.position[0] * scale, transform.position[1] * scale);
      context.rotate((transform.rotation[2] * Math.PI) / 180);
      context.globalAlpha = transform.opacity * resolvedColor[3];
      context.fillStyle = `rgb(${resolvedColor
        .slice(0, 3)
        .map((channel) => Math.round(channel * 255))
        .join(" ")})`;
      const width = (resolvedSize[0] * transform.scale[0] * scale) / 100;
      const height = (resolvedSize[1] * transform.scale[1] * scale) / 100;
      const anchorX = (transform.anchor[0] * transform.scale[0] * scale) / 100;
      const anchorY = (transform.anchor[1] * transform.scale[1] * scale) / 100;
      if (layer.kind === "text") {
        context.translate(-anchorX, -anchorY);
        drawTextLayer(
          context,
          layer,
          width,
          height,
          evaluateLayerSourceTime(layer, scene.localTime),
        );
      } else if (isDrawableMedia(media?.element))
        context.drawImage(media.element, -anchorX, -anchorY, width, height);
      else context.fillRect(-anchorX, -anchorY, width, height);
      context.restore();
    }
    this.#sweepMedia(activeMedia);
    const cpuMs = performance.now() - started;
    return {
      fps: Math.min(60, 1000 / Math.max(cpuMs, 16.67)),
      frameMs: Math.max(cpuMs, 16.67),
      cpuMs,
      drawCalls,
      passCount: 1,
      dirtyNodes: sceneLayers.length,
      cacheHitRate: 0,
      estimatedVramMb: 0,
      transientTextureCount: 0,
    };
  }

  async complete(): Promise<void> {
    this.#assertActive();
    const started = performance.now();
    const needsRedraw = this.#pendingMediaResources.size > 0;
    await this.waitForFrameResources();
    if (!needsRedraw) return;
    const request = this.#lastRender;
    if (!request) return;
    this.render(
      request.composition,
      request.time,
      request.playing,
      request.project,
      request.selectedLayerId,
    );
    await this.waitForFrameResources(remainingCanvasTimeout(started, 10_000));
  }

  /** Waits for the current source generation before deterministic pixel readback. */
  async waitForFrameResources(timeoutMs = 10_000, signal?: AbortSignal): Promise<void> {
    this.#assertActive();
    const started = performance.now();
    while (true) {
      if (signal?.aborted) throw canvasAbortError(signal.reason);
      const pending = [...this.#pendingMediaResources.values()];
      if (pending.length > 0)
        await waitForCanvasResource(
          Promise.all(pending.map((resource) => resource.promise)).then(() => undefined),
          remainingCanvasTimeout(started, timeoutMs),
          signal,
          "Timed out waiting for exact Canvas media resources",
        );
      if (this.#pendingMediaResources.size > 0) continue;
      const failure = this.#mediaResourceErrors.values().next().value as
        | { source: string; error: Error }
        | undefined;
      if (failure) throw failure.error;
      return;
    }
  }

  setMemoryBudget(_megabytes?: number): void {}

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const resource of this.#mediaResources.values()) disposeCanvasMedia(resource);
    this.#mediaResources.clear();
    this.#pendingMediaResources.clear();
    this.#mediaResourceErrors.clear();
    this.#lastRender = undefined;
    this.#context.clearRect(0, 0, this.#context.canvas.width, this.#context.canvas.height);
  }

  #assertActive(): void {
    if (this.#disposed) throw new Error("Canvas renderer is disposed");
  }

  #prepareMedia(
    layer: Layer,
    footage: FootageSource | undefined,
    time: number,
    playing: boolean,
    instanceId: string,
  ): CanvasMediaResource | undefined {
    const source = footage && sourceLocator(footage);
    if ((layer.kind !== "image" && layer.kind !== "video") || !source) return undefined;
    const runtime = footage && mediaImportRuntime.get(footage.id);
    if (runtime?.kind === "psd") return this.#preparePsd(runtime, footage, source, instanceId);
    if (runtime?.kind === "svg")
      return this.#prepareSvg(runtime, layer, footage, time, source, instanceId);
    if (runtime?.kind === "imageSequence") {
      const duration =
        ((runtime.selection.endFrame - runtime.selection.startFrame + 1) *
          runtime.frameRate.denominator) /
        runtime.frameRate.numerator;
      const mediaTime = evaluateLayerSourceTime(layer, time, duration);
      try {
        const frame = resolveImageSequenceFrame(runtime.selection, mediaTime, runtime.frameRate, {
          loop: runtime.loop,
          missingFramePolicy: runtime.missingFramePolicy,
        });
        const resource = this.#prepareElement(
          frame.file.url,
          layer,
          footage,
          time,
          playing,
          instanceId,
          { name: frame.file.name, mimeType: frame.file.type },
        );
        mediaImportRuntime.clearError(footage.id);
        return resource;
      } catch (error) {
        mediaImportRuntime.reportError(footage.id, error);
        const resolved = canvasResourceError(error);
        const generation = `${source}|sequence-error|${time}`;
        this.#pendingMediaResources.delete(instanceId);
        this.#mediaResourceErrors.set(instanceId, { source: generation, error: resolved });
        disposeCanvasMedia(this.#mediaResources.get(instanceId));
        this.#mediaResources.delete(instanceId);
        return undefined;
      }
    }
    return this.#prepareElement(source, layer, footage, time, playing, instanceId, {
      name: footage.name,
      mimeType: footage.mimeType,
    });
  }

  #prepareElement(
    source: string,
    layer: Layer,
    footage: FootageSource,
    time: number,
    playing: boolean,
    instanceId: string,
    identity: RasterImageIdentity,
  ): CanvasMediaResource {
    if (
      layer.kind !== "video" &&
      isTiffSource(identity.name, identity.mimeType) &&
      this.#mediaResources.get(instanceId)?.source !== source
    )
      return this.#prepareDecodedImage(source, footage, instanceId, identity);
    let resource = this.#mediaResources.get(instanceId);
    if (!resource || resource.source !== source) {
      disposeCanvasMedia(resource);
      this.#pendingMediaResources.delete(instanceId);
      this.#mediaResourceErrors.delete(instanceId);
      const element = layer.kind === "video" ? document.createElement("video") : new Image();
      if (element instanceof HTMLVideoElement) {
        element.preload = "auto";
        element.playsInline = true;
        configurePreviewVideoAudio(element, layer);
      }
      element.src = source;
      resource = { source, element };
      this.#mediaResources.set(instanceId, resource);
      if (element instanceof HTMLImageElement)
        this.#trackElementReady(instanceId, source, footage, imageReady(element));
    }
    if (resource.element instanceof HTMLVideoElement) {
      const video = resource.element;
      configurePreviewVideoAudio(video, layer);
      const duration = Number.isFinite(video.duration)
        ? video.duration
        : footage && "duration" in footage
          ? footage.duration
          : layer.outPoint - layer.inPoint;
      const mediaTime = evaluateLayerSourceTime(layer, time, Math.max(0, duration - 0.001));
      const seekTolerance = playing ? 0.12 : 1 / 240;
      if (Math.abs(video.currentTime - mediaTime) > seekTolerance) {
        try {
          video.currentTime = mediaTime;
        } catch (error) {
          this.#mediaResourceErrors.set(instanceId, {
            source,
            error: canvasResourceError(error),
          });
        }
      }
      const generation = `${source}|${mediaTime.toFixed(9)}`;
      if (
        video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA &&
        !video.seeking &&
        Math.abs(video.currentTime - mediaTime) <= seekTolerance
      ) {
        this.#pendingMediaResources.delete(instanceId);
        this.#mediaResourceErrors.delete(instanceId);
      } else {
        if (this.#pendingMediaResources.get(instanceId)?.source !== generation)
          this.#trackElementReady(
            instanceId,
            generation,
            footage,
            videoFrameReady(video, mediaTime, seekTolerance),
          );
      }
      if (playing && video.paused) void video.play().catch(() => undefined);
      else if (!playing && !video.paused) video.pause();
    }
    return resource;
  }

  #prepareDecodedImage(
    source: string,
    footage: FootageSource,
    instanceId: string,
    identity: RasterImageIdentity,
  ): CanvasMediaResource {
    disposeCanvasMedia(this.#mediaResources.get(instanceId));
    this.#pendingMediaResources.delete(instanceId);
    this.#mediaResourceErrors.delete(instanceId);
    const canvas = document.createElement("canvas");
    canvas.width = 0;
    canvas.height = 0;
    const resource = { source, element: canvas } satisfies CanvasMediaResource;
    this.#mediaResources.set(instanceId, resource);
    const work = fetch(source)
      .then((response) => {
        if (!response.ok) throw new Error(`Media request failed with HTTP ${response.status}`);
        return response.blob();
      })
      .then((blob) => decodeRasterImage(blob, identity))
      .then((bitmap) => {
        try {
          if (this.#mediaResources.get(instanceId) !== resource) return;
          canvas.width = bitmap.width;
          canvas.height = bitmap.height;
          const context = canvas.getContext("2d");
          if (!context) throw new Error("Canvas TIFF upload context is unavailable");
          context.drawImage(bitmap, 0, 0);
        } finally {
          bitmap.close();
        }
      });
    this.#trackElementReady(instanceId, source, footage, work);
    return resource;
  }

  #preparePsd(
    runtime: RuntimePsdLayer,
    footage: FootageSource,
    locator: string,
    instanceId: string,
  ): CanvasMediaResource | undefined {
    const [cropX, cropY, width, height] = runtime.crop;
    const source = `${locator}|${cropX},${cropY},${width},${height}`;
    const existing = this.#mediaResources.get(instanceId);
    if (existing?.source === source) return existing;
    if (
      width < 1 ||
      height < 1 ||
      cropX < 0 ||
      cropY < 0 ||
      cropX + width > runtime.decodedWidth ||
      cropY + height > runtime.decodedHeight ||
      runtime.pixels.byteLength < runtime.decodedWidth * runtime.decodedHeight * 4 ||
      !(runtime.pixels.buffer instanceof ArrayBuffer)
    ) {
      mediaImportRuntime.reportError(
        footage.id,
        new Error("PSD layer crop exceeds the decoded pixel bounds"),
      );
      this.#mediaResourceErrors.set(instanceId, {
        source,
        error: new Error("PSD layer crop exceeds the decoded pixel bounds"),
      });
      return undefined;
    }
    disposeCanvasMedia(existing);
    this.#pendingMediaResources.delete(instanceId);
    this.#mediaResourceErrors.delete(instanceId);
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) return undefined;
    const pixels = new Uint8ClampedArray(
      runtime.pixels.buffer,
      runtime.pixels.byteOffset,
      runtime.pixels.byteLength,
    );
    const image = new ImageData(pixels, runtime.decodedWidth, runtime.decodedHeight);
    context.putImageData(image, -cropX, -cropY, cropX, cropY, width, height);
    const resource = { source, element: canvas } satisfies CanvasMediaResource;
    this.#mediaResources.set(instanceId, resource);
    mediaImportRuntime.clearError(footage.id);
    return resource;
  }

  #prepareSvg(
    runtime: RuntimeSvgSource,
    layer: Layer,
    footage: FootageSource,
    time: number,
    locator: string,
    instanceId: string,
  ): CanvasMediaResource {
    const transform = evaluateLayerTransform(layer, time);
    const target = computeSvgRasterTarget({
      ...svgTransformedRasterSize(layer.size, transform.scale),
      resolutionScale: 1,
      maxTextureDimension: 8_192,
      maxPixels: 64 * 1024 * 1024,
    });
    const source = `${locator}|${target.width}x${target.height}`;
    const existing = this.#mediaResources.get(instanceId);
    if (existing?.source === source) return existing;
    disposeCanvasMedia(existing);
    this.#pendingMediaResources.delete(instanceId);
    this.#mediaResourceErrors.delete(instanceId);
    const markup = svgMarkupAtRasterSize(runtime.parsed.sanitized, target.width, target.height);
    const url = URL.createObjectURL(new Blob([markup], { type: "image/svg+xml" }));
    const element = new Image();
    element.src = url;
    const resource = {
      source,
      element,
      revoke: () => URL.revokeObjectURL(url),
    } satisfies CanvasMediaResource;
    this.#mediaResources.set(instanceId, resource);
    this.#trackElementReady(
      instanceId,
      source,
      footage,
      imageReady(element, "SVG raster decode failed"),
    );
    return resource;
  }

  #trackElementReady(
    instanceId: string,
    source: string,
    footage: FootageSource,
    work: Promise<void>,
  ): void {
    const pending: PendingCanvasResource = {
      source,
      promise: work
        .then(() => {
          if (this.#pendingMediaResources.get(instanceId) !== pending) return;
          this.#pendingMediaResources.delete(instanceId);
          this.#mediaResourceErrors.delete(instanceId);
          mediaImportRuntime.clearError(footage.id);
        })
        .catch((error: unknown) => {
          if (this.#pendingMediaResources.get(instanceId) !== pending) return;
          this.#pendingMediaResources.delete(instanceId);
          const resolved = canvasResourceError(error);
          this.#mediaResourceErrors.set(instanceId, { source, error: resolved });
          mediaImportRuntime.reportError(footage.id, resolved);
          throw resolved;
        }),
    };
    this.#pendingMediaResources.set(instanceId, pending);
    void pending.promise.catch(() => undefined);
  }

  #sweepMedia(activeLayerIds: Set<string>): void {
    for (const [layerId, resource] of this.#mediaResources) {
      if (activeLayerIds.has(layerId)) continue;
      disposeCanvasMedia(resource);
      this.#mediaResources.delete(layerId);
      this.#pendingMediaResources.delete(layerId);
      this.#mediaResourceErrors.delete(layerId);
    }
  }
}

function imageReady(element: HTMLImageElement, message = "Image decode failed"): Promise<void> {
  if (element.complete)
    return element.naturalWidth > 0 ? Promise.resolve() : Promise.reject(new Error(message));
  return new Promise<void>((resolve, reject) => {
    element.addEventListener("load", () => resolve(), { once: true });
    element.addEventListener("error", () => reject(new Error(message)), { once: true });
  });
}

function videoFrameReady(
  video: HTMLVideoElement,
  targetTime: number,
  tolerance: number,
): Promise<void> {
  const ready = () =>
    video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA &&
    !video.seeking &&
    Math.abs(video.currentTime - targetTime) <= tolerance;
  if (ready()) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const settle = () => {
      if (!ready()) return;
      cleanup();
      resolve();
    };
    const fail = () => {
      cleanup();
      reject(new Error(video.error?.message || "Video frame decode failed"));
    };
    const cleanup = () => {
      video.removeEventListener("loadeddata", settle);
      video.removeEventListener("seeked", settle);
      video.removeEventListener("timeupdate", settle);
      video.removeEventListener("error", fail);
    };
    video.addEventListener("loadeddata", settle);
    video.addEventListener("seeked", settle);
    video.addEventListener("timeupdate", settle);
    video.addEventListener("error", fail, { once: true });
  });
}

function remainingCanvasTimeout(started: number, timeoutMs: number): number {
  const bounded = Number.isFinite(timeoutMs) ? Math.max(1, timeoutMs) : 10_000;
  return Math.max(0, bounded - (performance.now() - started));
}

function waitForCanvasResource<T>(
  promise: Promise<T>,
  timeoutMs: number,
  signal: AbortSignal | undefined,
  timeoutMessage: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (signal?.aborted) {
      reject(canvasAbortError(signal.reason));
      return;
    }
    const timeout = setTimeout(() => finish(() => reject(new Error(timeoutMessage))), timeoutMs);
    const abort = () => finish(() => reject(canvasAbortError(signal?.reason)));
    const finish = (action: () => void) => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
      action();
    };
    signal?.addEventListener("abort", abort, { once: true });
    promise.then(
      (value) => finish(() => resolve(value)),
      (error) => finish(() => reject(error)),
    );
  });
}

function canvasAbortError(reason: unknown): DOMException {
  return new DOMException(
    typeof reason === "string" ? reason : "Frame render aborted",
    "AbortError",
  );
}

function canvasResourceError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function isDrawableMedia(
  element: HTMLCanvasElement | HTMLImageElement | HTMLVideoElement | undefined,
): element is HTMLCanvasElement | HTMLImageElement | HTMLVideoElement {
  if (element instanceof HTMLCanvasElement) return element.width > 0 && element.height > 0;
  if (element instanceof HTMLImageElement) return element.complete && element.naturalWidth > 0;
  return (
    element instanceof HTMLVideoElement && element.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA
  );
}

function disposeCanvasMedia(resource: CanvasMediaResource | undefined): void {
  if (!resource) return;
  if (resource.element instanceof HTMLVideoElement) {
    resource.element.pause();
    resource.element.removeAttribute("src");
    resource.element.load();
    resource.element.remove();
  }
  if (resource.element instanceof HTMLCanvasElement) {
    resource.element.width = 1;
    resource.element.height = 1;
    resource.element.remove();
  }
  resource.revoke?.();
}

function canvasBlendMode(
  mode: Composition["layers"][number]["blendMode"],
): GlobalCompositeOperation {
  if (mode === "add") return "lighter";
  if (mode === "normal") return "source-over";
  return mode;
}
