import { activateProjectFonts, prepareProjectFonts } from "../../core/media/project-font-runtime";
import { type AntiAliasingMode, normalizeAntiAliasing } from "../../core/rendering/anti-aliasing";
import type { Composition, Project, RendererMetrics } from "../../core/types";
import type { CanvasFallbackRenderer } from "../canvas-fallback";
import type { RawFramePixelFormat, RawVideoFrame } from "../gpu/frame-readback";
import { WebGpuRenderer } from "../webgpu-renderer";

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
  antiAliasing: AntiAliasingMode;
}

export interface BeautyFrameBackend {
  readonly maxConcurrentReadbacks: number;
  readonly pixelFormat: RawFramePixelFormat;
  currentTarget(): BeautyFrameTarget;
  resize(width: number, height: number): void;
  prepareTarget?(target: BeautyFrameTarget, mode: AntiAliasingMode): void;
  present(
    request: BeautyFrameRequest,
    selectedLayerId?: string,
    playing?: boolean,
  ): RendererMetrics;
  readback(request: BeautyFrameRequest, synchronizeVideo: boolean): Promise<RawVideoFrame>;
}

export function createBeautyFrameRequest(options: {
  antiAliasing?: AntiAliasingMode;
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
    antiAliasing: normalizeAntiAliasing(options.antiAliasing),
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

  present(
    request: BeautyFrameRequest,
    selectedLayerId?: string,
    playing?: boolean,
  ): RendererMetrics {
    validateBeautyFrameRequest(request);
    this.#prepare(request);
    return this.#backend.present(request, selectedLayerId, playing);
  }

  async readback(request: BeautyFrameRequest, synchronizeVideo = false): Promise<RawVideoFrame> {
    validateBeautyFrameRequest(request);
    this.#prepare(request);
    const frame = await this.#backend.readback(request, synchronizeVideo);
    if (frame.pixelFormat !== this.pixelFormat)
      throw new Error("Beauty frame backend changed pixel format during a render session");
    const expectedBytes = request.target.width * request.target.height * 4;
    if (frame.pixels.byteLength !== expectedBytes)
      throw new Error(
        `Beauty frame readback returned ${frame.pixels.byteLength} bytes; expected ${expectedBytes} ` +
          `for ${request.target.width}x${request.target.height} packed 8-bit pixels`,
      );
    return frame;
  }
  #prepare(request: BeautyFrameRequest): void {
    if (this.#backend.prepareTarget)
      this.#backend.prepareTarget(request.target, request.antiAliasing);
    else this.resize(request.target.width, request.target.height);
  }
}

export function createViewportBeautyFrameBackend(
  renderer: WebGpuRenderer | CanvasFallbackRenderer,
  canvas: HTMLCanvasElement,
): BeautyFrameBackend {
  let presentationPending = false;
  let presentationCompletion: Promise<void> | undefined;
  const activateBeauty = () => {
    if (renderer instanceof WebGpuRenderer && renderer.bufferVisualization !== "beauty")
      renderer.setBufferVisualization("beauty");
  };
  return {
    prepareTarget: (target, mode) => {
      if (canvas.width !== target.width) canvas.width = target.width;
      if (canvas.height !== target.height) canvas.height = target.height;
      if (renderer instanceof WebGpuRenderer)
        renderer.configureBeautyTarget(target.width, target.height, mode);
      else {
        if (mode !== "off") throw new Error("Output anti-aliasing requires WebGPU");
        if (renderer.outputWidth !== target.width || renderer.outputHeight !== target.height)
          renderer.resize(target.width, target.height);
      }
    },
    pixelFormat: renderer instanceof WebGpuRenderer ? renderer.exportPixelFormat : "rgba",
    maxConcurrentReadbacks: renderer instanceof WebGpuRenderer ? 3 : 1,
    // Canvas dimensions are presentation state, not proof that the renderer has allocated a
    // matching render graph. RenderHost sizes its hidden canvas while a new renderer is still 1x1.
    currentTarget: () => ({ width: renderer.outputWidth, height: renderer.outputHeight }),
    resize: (width, height) => {
      canvas.width = width;
      canvas.height = height;
      renderer.resize(width, height);
    },
    present: (request, selectedLayerId, playing = false) => {
      activateProjectFonts(request.project);
      activateBeauty();
      presentationPending = true;
      return renderer.render(
        request.composition,
        request.time,
        playing,
        request.project,
        selectedLayerId,
      );
    },
    readback: async (request, synchronizeVideo) => {
      // A preview may still be using the canvas presentation texture. Settle that transition once;
      // subsequent export frames retain the bounded concurrent readback path.
      if (presentationPending && renderer instanceof WebGpuRenderer) {
        presentationPending = false;
        presentationCompletion = renderer.complete();
      }
      const completion = presentationCompletion;
      await completion;
      if (presentationCompletion === completion) presentationCompletion = undefined;
      await prepareProjectFonts(request.project);
      activateProjectFonts(request.project);
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
