import { activateProjectFonts, prepareProjectFonts } from "../../core/media/project-font-runtime";
import type { CanvasFallbackRenderer } from "../canvas-fallback";
import { validateReadbackDestination } from "../gpu/frame-readback";
import type { BeautyFrameBackend } from "./beauty-frame";

/** Compatibility presentation retains its existing Canvas behavior without a TS GPU dependency. */
export function createCanvasBeautyBackend(
  renderer: CanvasFallbackRenderer,
  canvas: HTMLCanvasElement,
): BeautyFrameBackend {
  return {
    pixelFormat: "rgba",
    maxConcurrentReadbacks: 1,
    currentTarget: () => ({ width: renderer.outputWidth, height: renderer.outputHeight }),
    resize: (width, height) => {
      canvas.width = width;
      canvas.height = height;
      renderer.resize(width, height);
    },
    prepareTarget: (target, mode) => {
      if (canvas.width !== target.width) canvas.width = target.width;
      if (canvas.height !== target.height) canvas.height = target.height;
      if (mode !== "off") throw Error("Output anti-aliasing requires WebGPU");
      if (renderer.outputWidth !== target.width || renderer.outputHeight !== target.height)
        renderer.resize(target.width, target.height);
    },
    present: (request, selectedLayerId, playing = false) => {
      activateProjectFonts(request.project);
      return renderer.render(
        request.composition,
        request.time,
        playing,
        request.project,
        selectedLayerId,
        true,
      );
    },
    readback: async (request, synchronizeVideo, destination) => {
      await prepareProjectFonts(request.project);
      activateProjectFonts(request.project);
      if (synchronizeVideo) throw Error("Deterministic video export requires the native renderer");
      renderer.render(request.composition, request.time, false, request.project);
      await renderer.complete();
      const context = canvas.getContext("2d");
      if (!context) throw Error("Canvas fallback pixels are unavailable");
      const source = context.getImageData(0, 0, canvas.width, canvas.height).data;
      if (destination !== undefined) {
        validateReadbackDestination(destination, canvas.width, canvas.height);
        new Uint8Array(destination).set(source);
        return { pixels: destination, pixelFormat: "rgba" };
      }
      return { pixels: new Uint8Array(source).slice().buffer, pixelFormat: "rgba" };
    },
  };
}
