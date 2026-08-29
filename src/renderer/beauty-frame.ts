import type { Composition, Project, RendererMetrics } from "../core/types";
import type { CanvasFallbackRenderer } from "./canvas-fallback";
import type { RawFramePixelFormat, RawVideoFrame } from "./frame-readback";
import { WebGpuRenderer } from "./webgpu-renderer";

export const PRODUCTION_BEAUTY_SETTINGS = Object.freeze({
  buffer: "beauty",
  colorPipeline: "linear-hdr-to-aces-display",
  effects: "composition",
  sampling: "composition",
} as const);

export interface BeautyFrameTarget {
  width: number;
  height: number;
}

/**
 * One time-addressed production frame request. Preview scale is represented only by `target`;
 * effects, color processing, sampling, and the beauty output route are immutable.
 */
export interface BeautyFrameRequest {
  composition: Composition;
  project: Project;
  time: number;
  target: BeautyFrameTarget;
  settings: typeof PRODUCTION_BEAUTY_SETTINGS;
}

export interface BeautyFrameBackend {
  readonly maxConcurrentReadbacks: number;
  readonly pixelFormat: RawFramePixelFormat;
  currentTarget(): BeautyFrameTarget;
  resize(width: number, height: number): void;
  present(request: BeautyFrameRequest, selectedLayerId?: string): RendererMetrics;
  readback(request: BeautyFrameRequest, synchronizeVideo: boolean): Promise<RawVideoFrame>;
}

export function createBeautyFrameRequest(options: {
  composition: Composition;
  project: Project;
  time: number;
  width: number;
  height: number;
}): BeautyFrameRequest {
  const target = validatedTarget(options.width, options.height);
  if (!Number.isFinite(options.time)) throw new Error("Beauty frame time must be finite");
  return {
    composition: options.composition,
    project: options.project,
    time: options.time,
    target,
    settings: PRODUCTION_BEAUTY_SETTINGS,
  };
}

/** Routes production presentation and export readback through one immutable beauty contract. */
export class ProductionBeautyFramePipeline {
  readonly #backend: BeautyFrameBackend;

  constructor(backend: BeautyFrameBackend) {
    this.#backend = backend;
  }

  get maxConcurrentReadbacks(): number {
    return this.#backend.maxConcurrentReadbacks;
  }

  get pixelFormat(): RawFramePixelFormat {
    return this.#backend.pixelFormat;
  }

  resize(width: number, height: number): void {
    const target = validatedTarget(width, height);
    const current = this.#backend.currentTarget();
    if (current.width === target.width && current.height === target.height) return;
    this.#backend.resize(target.width, target.height);
  }

  present(request: BeautyFrameRequest, selectedLayerId?: string): RendererMetrics {
    validateBeautyFrameRequest(request);
    this.resize(request.target.width, request.target.height);
    return this.#backend.present(request, selectedLayerId);
  }

  async readback(request: BeautyFrameRequest, synchronizeVideo = false): Promise<RawVideoFrame> {
    validateBeautyFrameRequest(request);
    this.resize(request.target.width, request.target.height);
    const frame = await this.#backend.readback(request, synchronizeVideo);
    if (frame.pixelFormat !== this.pixelFormat)
      throw new Error("Beauty frame backend changed pixel format during a render session");
    if (frame.pixels.byteLength !== request.target.width * request.target.height * 4)
      throw new Error("Beauty frame readback did not return one packed 8-bit pixel buffer");
    return frame;
  }
}

export function createViewportBeautyFrameBackend(
  renderer: WebGpuRenderer | CanvasFallbackRenderer,
  canvas: HTMLCanvasElement,
): BeautyFrameBackend {
  const activateBeauty = () => {
    if (renderer instanceof WebGpuRenderer && renderer.bufferVisualization !== "beauty")
      renderer.setBufferVisualization("beauty");
  };
  return {
    pixelFormat: renderer instanceof WebGpuRenderer ? renderer.exportPixelFormat : "rgba",
    maxConcurrentReadbacks: renderer instanceof WebGpuRenderer ? 3 : 1,
    currentTarget: () => ({ width: canvas.width, height: canvas.height }),
    resize: (width, height) => {
      canvas.width = width;
      canvas.height = height;
      renderer.resize(width, height);
    },
    present: (request, selectedLayerId) => {
      activateBeauty();
      return renderer.render(
        request.composition,
        request.time,
        false,
        request.project,
        selectedLayerId,
      );
    },
    readback: async (request, synchronizeVideo) => {
      activateBeauty();
      if (renderer instanceof WebGpuRenderer)
        return renderer.renderRawFrame(
          request.composition,
          request.time,
          request.project,
          synchronizeVideo,
        );
      if (synchronizeVideo)
        throw new Error("Deterministic video export requires the WebGPU renderer");
      renderer.render(request.composition, request.time, false, request.project);
      await renderer.complete();
      const context = canvas.getContext("2d");
      if (!context) throw new Error("Canvas fallback pixels are unavailable");
      const source = context.getImageData(0, 0, canvas.width, canvas.height).data;
      return { pixels: new Uint8Array(source).slice().buffer, pixelFormat: "rgba" };
    },
  };
}

function validateBeautyFrameRequest(request: BeautyFrameRequest): void {
  if (request.settings !== PRODUCTION_BEAUTY_SETTINGS)
    throw new Error("Production beauty settings cannot be overridden per frame");
  if (!Number.isFinite(request.time)) throw new Error("Beauty frame time must be finite");
  validatedTarget(request.target.width, request.target.height);
}

function validatedTarget(width: number, height: number): BeautyFrameTarget {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1)
    throw new Error("Beauty frame dimensions must be positive integers");
  return { width, height };
}
