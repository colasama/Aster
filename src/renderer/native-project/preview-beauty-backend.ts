import type { BeautyFrameBackend } from "../compositing/beauty-frame";
import type { NativePreviewView } from "./preview-view";

/** Explicit captures share native evaluation while keeping their pixels off the visible canvas. */
export function createNativePreviewBeautyBackend(view: NativePreviewView): BeautyFrameBackend {
  const canvas = view.canvas.canvas;
  return {
    maxConcurrentReadbacks: 1,
    pixelFormat: view.canvas.format === "bgra8unorm" ? "bgra" : "rgba",
    currentTarget: () => ({ width: canvas.width, height: canvas.height }),
    resize: (width, height) => {
      canvas.width = width;
      canvas.height = height;
    },
    present: () => {
      throw new Error("Native viewport presentation requires the asynchronous preview queue");
    },
    readback: (request, _synchronizeVideo, destination) =>
      view.readback(request, view.memoryBudgetMb, destination),
  };
}
