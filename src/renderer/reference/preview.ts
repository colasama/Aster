import type { CanvasFallbackRenderer } from "../canvas-fallback";
import type { BeautyFrameBackend } from "../presentation/beauty-frame";
import type { WebGpuRenderer } from "../webgpu-renderer";

const references = new WeakSet<WebGpuRenderer>();

/** Only explicitly constructed reference sessions can enter retained TS viewport operations. */
export function isReferencePreview(
  renderer: WebGpuRenderer | CanvasFallbackRenderer | undefined,
): renderer is WebGpuRenderer {
  return renderer !== undefined && references.has(renderer as WebGpuRenderer);
}

export async function createReferencePreview(
  canvas: HTMLCanvasElement,
  invalidate: () => void,
): Promise<{ renderer: WebGpuRenderer; backend: BeautyFrameBackend }> {
  if (!__ASTER_TS_REFERENCE__) throw Error("TS preview requires an explicit reference build");
  const [{ WebGpuRenderer }, { createViewportBeautyFrameBackend }] = await Promise.all([
    import("../webgpu-renderer"),
    import("../compositing/beauty-frame"),
  ]);
  const renderer = await WebGpuRenderer.create(canvas, invalidate);
  references.add(renderer);
  return { renderer, backend: createViewportBeautyFrameBackend(renderer, canvas) };
}
