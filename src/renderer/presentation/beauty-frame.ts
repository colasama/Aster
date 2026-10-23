import { type AntiAliasingMode, normalizeAntiAliasing } from "../../core/rendering/anti-aliasing";
import {
  copyRenderSnapshotIdentity,
  type RenderSnapshotIdentity,
  validateRenderSnapshotIdentity,
} from "../../core/rendering/render-snapshot";
import type { Composition, Project, RendererMetrics } from "../../core/types";
import {
  type RawFramePixelFormat,
  type RawVideoFrame,
  validateReadbackDestination,
} from "../gpu/frame-readback";

export const PRODUCTION_BEAUTY_SETTINGS = Object.freeze({
  buffer: "beauty",
  colorPipeline: "linear-hdr-to-srgb-display",
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
  readonly snapshot: RenderSnapshotIdentity;
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
  readback(
    request: BeautyFrameRequest,
    synchronizeVideo: boolean,
    destination?: ArrayBuffer,
  ): Promise<RawVideoFrame>;
}

export function createBeautyFrameRequest(options: {
  snapshot: RenderSnapshotIdentity;
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
    snapshot: copyRenderSnapshotIdentity(options.snapshot),
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

  async readback(
    request: BeautyFrameRequest,
    synchronizeVideo = false,
    destination?: ArrayBuffer,
  ): Promise<RawVideoFrame> {
    validateBeautyFrameRequest(request);
    if (destination !== undefined)
      validateReadbackDestination(destination, request.target.width, request.target.height);
    this.#prepare(request);
    const frame = await this.#backend.readback(request, synchronizeVideo, destination);
    if (destination !== undefined && frame.pixels !== destination)
      throw new Error("Beauty frame backend did not use the supplied readback destination");
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

function validateBeautyFrameRequest(request: BeautyFrameRequest): void {
  validateRenderSnapshotIdentity(request.snapshot);
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
