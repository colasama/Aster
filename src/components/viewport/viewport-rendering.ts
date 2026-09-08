import type { Composition, GpuDiagnostics, Project } from "../../core/types";

import type { PlainMessageKey, Translate } from "../../i18n/core";

import type { CanvasFallbackRenderer } from "../../renderer/canvas-fallback";
import type { BufferVisualization } from "../../renderer/gpu/render-buffers";

import type { WebGpuRenderer } from "../../renderer/webgpu-renderer";

export type Renderer = WebGpuRenderer | CanvasFallbackRenderer;

export function shallowDiagnosticsEqual(left: GpuDiagnostics, right: GpuDiagnostics): boolean {
  const leftKeys = Object.keys(left) as (keyof GpuDiagnostics)[];
  const rightKeys = Object.keys(right) as (keyof GpuDiagnostics)[];
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every((key) => Object.is(left[key], right[key]))
  );
}

export function bufferViewLabel(mode: BufferVisualization, t: Translate): string {
  const keys: Record<BufferVisualization, PlainMessageKey> = {
    beauty: "viewport.buffer.beauty",
    linearColor: "viewport.buffer.linearColor",
    luminance: "viewport.buffer.luminance",
    alpha: "viewport.buffer.alpha",
    depthFog: "viewport.buffer.depthFog",
    depthOfField: "viewport.buffer.depthOfField",
    selectionIsolation: "viewport.buffer.selectionIsolation",
    vectorMotionBlur: "viewport.buffer.vectorMotionBlur",
    normal: "viewport.buffer.normal",
    objectId: "viewport.buffer.objectId",
    materialId: "viewport.buffer.materialId",
    worldPosition: "viewport.buffer.worldPosition",
    motionVector: "viewport.buffer.motionVector",
  };
  return t(keys[mode]);
}

export function syncMirrorCanvas(
  source: HTMLCanvasElement | null,
  target: HTMLCanvasElement | null,
): void {
  if (!source || !target) return;
  if (target.width !== source.width) target.width = source.width;
  if (target.height !== source.height) target.height = source.height;
  requestAnimationFrame(() => target.getContext("2d")?.drawImage(source, 0, 0));
}

export function toggleFullscreen(element: Element | null): void {
  if (document.fullscreenElement) void document.exitFullscreen();
  else if (element instanceof HTMLElement) void element.requestFullscreen();
}

export function compositionContainsVideo(
  composition: Composition,
  project: Project,
  visited = new Set<string>(),
): boolean {
  if (visited.has(composition.id)) return false;
  visited.add(composition.id);
  return composition.layers.some((layer) => {
    if (layer.kind === "video") return true;
    if (layer.kind !== "precomposition" || !layer.sourceCompositionId) return false;
    const source = project.compositions.find(
      (candidate) => candidate.id === layer.sourceCompositionId,
    );
    return source ? compositionContainsVideo(source, project, visited) : false;
  });
}

export function disposeRenderer(renderer: Renderer | undefined): void {
  renderer?.dispose();
}
