import { configurePreviewVideoAudio } from "../core/audio-preview";
import { evaluateLayerTransform } from "../core/expressions";
import { sourceForLayer, sourceLocator } from "../core/footage-source";
import { evaluateLayerSourceTime } from "../core/layer-time";
import { flattenSceneLayers } from "../core/scene-evaluation";
import { solidRenderColor, solidRenderSize } from "../core/solid-layer";
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
import { computeSvgRasterTarget, svgMarkupAtRasterSize } from "../importers/svg-raster-cache";
import { drawTextLayer } from "./text-rasterizer";

interface CanvasMediaResource {
  source: string;
  element: HTMLCanvasElement | HTMLImageElement | HTMLVideoElement;
  revoke?: () => void;
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
  #width = 1;
  #height = 1;

  constructor(canvas: HTMLCanvasElement) {
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Canvas rendering is unavailable");
    this.#context = context;
  }

  resize(width: number, height: number): void {
    this.#width = width;
    this.#height = height;
  }

  render(
    composition: Composition,
    time: number,
    playing = false,
    project?: Project,
    _selectedLayerId?: string,
  ): RendererMetrics {
    const started = performance.now();
    const context = this.#context;
    context.clearRect(0, 0, this.#width, this.#height);
    context.fillStyle = "#060814";
    context.fillRect(0, 0, this.#width, this.#height);
    const scale = this.#width / composition.width;
    const activeMedia = new Set<string>();
    const sceneLayers = flattenSceneLayers(composition, project, time);
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
      if (layer.kind === "text") {
        context.translate(-width / 2, -height / 2);
        drawTextLayer(
          context,
          layer,
          width,
          height,
          evaluateLayerSourceTime(layer, scene.localTime),
        );
      } else if (isDrawableMedia(media?.element))
        context.drawImage(media.element, -width / 2, -height / 2, width, height);
      else context.fillRect(-width / 2, -height / 2, width, height);
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
    await Promise.resolve();
  }

  setMemoryBudget(_megabytes?: number): void {}

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
        );
        mediaImportRuntime.clearError(footage.id);
        return resource;
      } catch (error) {
        mediaImportRuntime.reportError(footage.id, error);
        return undefined;
      }
    }
    return this.#prepareElement(source, layer, footage, time, playing, instanceId);
  }

  #prepareElement(
    source: string,
    layer: Layer,
    footage: FootageSource,
    time: number,
    playing: boolean,
    instanceId: string,
  ): CanvasMediaResource {
    let resource = this.#mediaResources.get(instanceId);
    if (!resource || resource.source !== source) {
      disposeCanvasMedia(resource);
      const element = layer.kind === "video" ? document.createElement("video") : new Image();
      if (element instanceof HTMLVideoElement) {
        element.preload = "auto";
        element.playsInline = true;
        configurePreviewVideoAudio(element, layer);
      }
      element.src = source;
      resource = { source, element };
      this.#mediaResources.set(instanceId, resource);
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
      if (Math.abs(video.currentTime - mediaTime) > (playing ? 0.12 : 1 / 240))
        video.currentTime = mediaTime;
      if (playing && video.paused) void video.play().catch(() => undefined);
      else if (!playing && !video.paused) video.pause();
    }
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
      return undefined;
    }
    disposeCanvasMedia(existing);
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
      displayWidth: Math.abs((layer.size[0] * transform.scale[0]) / 100),
      displayHeight: Math.abs((layer.size[1] * transform.scale[1]) / 100),
      resolutionScale: 1,
      maxTextureDimension: 8_192,
      maxPixels: 64 * 1024 * 1024,
    });
    const source = `${locator}|${target.width}x${target.height}`;
    const existing = this.#mediaResources.get(instanceId);
    if (existing?.source === source) return existing;
    disposeCanvasMedia(existing);
    const markup = svgMarkupAtRasterSize(runtime.parsed.sanitized, target.width, target.height);
    const url = URL.createObjectURL(new Blob([markup], { type: "image/svg+xml" }));
    const element = new Image();
    element.addEventListener("load", () => mediaImportRuntime.clearError(footage.id), {
      once: true,
    });
    element.addEventListener(
      "error",
      () => mediaImportRuntime.reportError(footage.id, new Error("SVG raster decode failed")),
      { once: true },
    );
    element.src = url;
    const resource = {
      source,
      element,
      revoke: () => URL.revokeObjectURL(url),
    } satisfies CanvasMediaResource;
    this.#mediaResources.set(instanceId, resource);
    return resource;
  }

  #sweepMedia(activeLayerIds: Set<string>): void {
    for (const [layerId, resource] of this.#mediaResources) {
      if (activeLayerIds.has(layerId)) continue;
      disposeCanvasMedia(resource);
      this.#mediaResources.delete(layerId);
    }
  }
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
  if (resource.element instanceof HTMLVideoElement) resource.element.pause();
  resource.revoke?.();
}

function canvasBlendMode(
  mode: Composition["layers"][number]["blendMode"],
): GlobalCompositeOperation {
  if (mode === "add") return "lighter";
  if (mode === "normal") return "source-over";
  return mode;
}
