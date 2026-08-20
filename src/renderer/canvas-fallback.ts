import { evaluateLayerSourceTime } from "../core/layer-time";
import { flattenSceneLayers } from "../core/scene-evaluation";
import type { Composition, GpuDiagnostics, Layer, Project, RendererMetrics } from "../core/types";
import { drawTextLayer } from "./text-rasterizer";

interface CanvasMediaResource {
  source: string;
  element: HTMLImageElement | HTMLVideoElement;
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
  ): RendererMetrics {
    const started = performance.now();
    const context = this.#context;
    context.clearRect(0, 0, this.#width, this.#height);
    context.fillStyle = "#060814";
    context.fillRect(0, 0, this.#width, this.#height);
    const scale = this.#width / composition.width;
    const activeMedia = new Set<string>();
    const sceneLayers = flattenSceneLayers(composition, project, time);
    for (const scene of sceneLayers.reverse()) {
      const { layer, transform } = scene;
      if (layer.kind === "camera" || layer.kind === "particle" || layer.kind === "light") continue;
      const media = this.#prepareMedia(layer, scene.localTime, playing, scene.instanceId);
      if (media) activeMedia.add(scene.instanceId);
      context.save();
      context.globalCompositeOperation = canvasBlendMode(layer.blendMode);
      context.translate(transform.position[0] * scale, transform.position[1] * scale);
      context.rotate((transform.rotation[2] * Math.PI) / 180);
      context.globalAlpha = transform.opacity * layer.color[3];
      context.fillStyle = `rgb(${layer.color
        .slice(0, 3)
        .map((channel) => Math.round(channel * 255))
        .join(" ")})`;
      const width = (layer.size[0] * transform.scale[0] * scale) / 100;
      const height = (layer.size[1] * transform.scale[1] * scale) / 100;
      if (layer.kind === "text") drawTextLayer(context, layer, width, height);
      else if (isDrawableMedia(media?.element))
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
      drawCalls: sceneLayers.length,
      passCount: 1,
      dirtyNodes: sceneLayers.length,
      cacheHitRate: 0,
      estimatedVramMb: 0,
    };
  }

  async complete(): Promise<void> {
    await Promise.resolve();
  }

  #prepareMedia(
    layer: Layer,
    time: number,
    playing: boolean,
    instanceId: string,
  ): CanvasMediaResource | undefined {
    if ((layer.kind !== "image" && layer.kind !== "video") || !layer.asset?.dataUrl)
      return undefined;
    let resource = this.#mediaResources.get(instanceId);
    if (!resource || resource.source !== layer.asset.dataUrl) {
      if (resource?.element instanceof HTMLVideoElement) resource.element.pause();
      const element = layer.kind === "video" ? document.createElement("video") : new Image();
      if (element instanceof HTMLVideoElement) {
        element.preload = "auto";
        element.playsInline = true;
        element.muted = !layer.audioEnabled;
      }
      element.src = layer.asset.dataUrl;
      resource = { source: layer.asset.dataUrl, element };
      this.#mediaResources.set(instanceId, resource);
    }
    if (resource.element instanceof HTMLVideoElement) {
      const video = resource.element;
      video.muted = !layer.audioEnabled;
      const duration = Number.isFinite(video.duration)
        ? video.duration
        : (layer.asset.duration ?? layer.outPoint - layer.inPoint);
      const mediaTime = evaluateLayerSourceTime(layer, time, Math.max(0, duration - 0.001));
      if (Math.abs(video.currentTime - mediaTime) > (playing ? 0.12 : 1 / 240))
        video.currentTime = mediaTime;
      if (playing && video.paused) void video.play().catch(() => undefined);
      else if (!playing && !video.paused) video.pause();
    }
    return resource;
  }

  #sweepMedia(activeLayerIds: Set<string>): void {
    for (const [layerId, resource] of this.#mediaResources) {
      if (activeLayerIds.has(layerId)) continue;
      if (resource.element instanceof HTMLVideoElement) resource.element.pause();
      this.#mediaResources.delete(layerId);
    }
  }
}

function isDrawableMedia(
  element: HTMLImageElement | HTMLVideoElement | undefined,
): element is HTMLImageElement | HTMLVideoElement {
  if (element instanceof HTMLImageElement) return element.complete && element.naturalWidth > 0;
  return (
    element instanceof HTMLVideoElement && element.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA
  );
}

function canvasBlendMode(
  mode: Composition["layers"][number]["blendMode"],
): GlobalCompositeOperation {
  if (mode === "add") return "lighter";
  if (mode === "normal") return "source-over";
  return mode;
}
