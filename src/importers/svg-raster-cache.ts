import type { ParsedSvgSource } from "./svg";

export interface SvgRasterTargetInput {
  displayWidth: number;
  displayHeight: number;
  resolutionScale: number;
  devicePixelRatio?: number;
  maxTextureDimension?: number;
  maxPixels?: number;
}

export interface SvgRasterTarget {
  width: number;
  height: number;
  requestedWidth: number;
  requestedHeight: number;
  downsampleScale: number;
}

export interface SvgRasterCacheOptions<RasterType> {
  rasterize: (markup: string, width: number, height: number) => Promise<RasterType>;
  dispose?: (raster: RasterType) => void;
  maxEntries?: number;
  maxBytes?: number;
}

interface RasterEntry<RasterType> {
  raster: RasterType;
  bytes: number;
}

const DEFAULT_MAX_TEXTURE_DIMENSION = 8192;
const DEFAULT_MAX_PIXELS = 64 * 1024 * 1024;
const DEFAULT_MAX_ENTRIES = 8;
const DEFAULT_MAX_BYTES = 256 * 1024 * 1024;

/** Computes a vector raster target in physical preview/export pixels while preserving aspect. */
export function computeSvgRasterTarget(input: SvgRasterTargetInput): SvgRasterTarget {
  const physicalScale = positive(input.resolutionScale, 1) * positive(input.devicePixelRatio, 1);
  const requestedWidth = Math.max(
    1,
    Math.ceil(Math.abs(finite(input.displayWidth)) * physicalScale),
  );
  const requestedHeight = Math.max(
    1,
    Math.ceil(Math.abs(finite(input.displayHeight)) * physicalScale),
  );
  const maximumDimension = boundedInteger(
    input.maxTextureDimension,
    1,
    32_768,
    DEFAULT_MAX_TEXTURE_DIMENSION,
  );
  const maximumPixels = boundedInteger(input.maxPixels, 1, 512 * 1024 * 1024, DEFAULT_MAX_PIXELS);
  const dimensionScale = Math.min(
    1,
    maximumDimension / requestedWidth,
    maximumDimension / requestedHeight,
  );
  const pixelScale = Math.min(1, Math.sqrt(maximumPixels / (requestedWidth * requestedHeight)));
  const downsampleScale = Math.min(dimensionScale, pixelScale);
  return {
    width: Math.max(1, Math.floor(requestedWidth * downsampleScale)),
    height: Math.max(1, Math.floor(requestedHeight * downsampleScale)),
    requestedWidth,
    requestedHeight,
    downsampleScale,
  };
}

/** Rewrites only intrinsic output size; the sanitized viewBox remains the vector coordinate source. */
export function svgMarkupAtRasterSize(sanitized: string, width: number, height: number): string {
  const document = new DOMParser().parseFromString(sanitized, "image/svg+xml");
  if (document.querySelector("parsererror") || document.documentElement.localName !== "svg")
    throw new Error("Sanitized SVG source is invalid");
  document.documentElement.setAttribute("width", String(boundedInteger(width, 1, 32_768, 1)));
  document.documentElement.setAttribute("height", String(boundedInteger(height, 1, 32_768, 1)));
  return new XMLSerializer().serializeToString(document);
}

/** Bounded raster cache keyed by immutable source identity and exact physical target size. */
export class SvgRasterCache<RasterType> {
  readonly #rasterize: SvgRasterCacheOptions<RasterType>["rasterize"];
  readonly #dispose?: SvgRasterCacheOptions<RasterType>["dispose"];
  readonly #maxEntries: number;
  readonly #maxBytes: number;
  readonly #ready = new Map<string, RasterEntry<RasterType>>();
  readonly #pending = new Map<string, Promise<RasterType>>();
  #bytes = 0;
  #generation = 0;

  constructor(options: SvgRasterCacheOptions<RasterType>) {
    this.#rasterize = options.rasterize;
    this.#dispose = options.dispose;
    this.#maxEntries = boundedInteger(options.maxEntries, 1, 64, DEFAULT_MAX_ENTRIES);
    this.#maxBytes = boundedInteger(options.maxBytes, 1, 2 * 1024 * 1024 * 1024, DEFAULT_MAX_BYTES);
  }

  get size(): number {
    return this.#ready.size;
  }

  get bytes(): number {
    return this.#bytes;
  }

  async get(
    sourceIdentity: string,
    source: ParsedSvgSource,
    target: SvgRasterTarget,
  ): Promise<RasterType> {
    const key = `${sourceIdentity}|${target.width}x${target.height}`;
    const ready = this.#ready.get(key);
    if (ready) {
      this.#ready.delete(key);
      this.#ready.set(key, ready);
      return ready.raster;
    }
    const pending = this.#pending.get(key);
    if (pending) return pending;
    const generation = this.#generation;
    const markup = svgMarkupAtRasterSize(source.sanitized, target.width, target.height);
    let rasterized: Promise<RasterType>;
    rasterized = this.#rasterize(markup, target.width, target.height).then(
      (raster) => {
        if (this.#pending.get(key) === rasterized) this.#pending.delete(key);
        if (generation !== this.#generation) return raster;
        const bytes = target.width * target.height * 4;
        if (bytes > this.#maxBytes) return raster;
        this.#ready.set(key, { raster, bytes });
        this.#bytes += bytes;
        this.#evict();
        return raster;
      },
      (error: unknown) => {
        if (this.#pending.get(key) === rasterized) this.#pending.delete(key);
        throw error;
      },
    );
    this.#pending.set(key, rasterized);
    return rasterized;
  }

  clear(): void {
    this.#generation += 1;
    this.#pending.clear();
    for (const key of this.#ready.keys()) this.#remove(key);
  }

  #evict(): void {
    while (this.#ready.size > this.#maxEntries || this.#bytes > this.#maxBytes) {
      const oldestKey = this.#ready.keys().next().value;
      if (oldestKey === undefined) break;
      this.#remove(oldestKey);
    }
  }

  #remove(key: string): void {
    const entry = this.#ready.get(key);
    if (!entry) return;
    this.#ready.delete(key);
    this.#bytes -= entry.bytes;
    this.#dispose?.(entry.raster);
  }
}

export async function rasterizeSvgToImageBitmap(
  markup: string,
  width: number,
  height: number,
): Promise<ImageBitmap> {
  if (typeof createImageBitmap !== "function")
    throw new Error("SVG vector rasterization is unavailable in this renderer");
  const targetWidth = boundedInteger(width, 1, 32_768, 1);
  const targetHeight = boundedInteger(height, 1, 32_768, 1);
  const blob = new Blob([markup], { type: "image/svg+xml" });
  try {
    return await createImageBitmap(blob, {
      resizeWidth: targetWidth,
      resizeHeight: targetHeight,
      resizeQuality: "high",
      premultiplyAlpha: "premultiply",
      colorSpaceConversion: "none",
    });
  } catch (bitmapError) {
    try {
      return await rasterizeSvgThroughImageElement(blob, targetWidth, targetHeight);
    } catch (imageError) {
      throw new Error(
        `SVG rasterization failed at ${targetWidth}x${targetHeight}: ${errorMessage(bitmapError)}; fallback: ${errorMessage(imageError)}`,
      );
    }
  }
}

async function rasterizeSvgThroughImageElement(
  blob: Blob,
  width: number,
  height: number,
): Promise<ImageBitmap> {
  if (
    typeof Image !== "function" ||
    typeof document === "undefined" ||
    typeof URL?.createObjectURL !== "function"
  )
    throw new Error("DOM SVG rasterization is unavailable in this renderer");
  const source = URL.createObjectURL(blob);
  try {
    const image = new Image();
    image.decoding = "sync";
    image.src = source;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d", { alpha: true });
    if (!context) throw new Error("SVG fallback canvas context is unavailable");
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = "high";
    context.drawImage(image, 0, 0, width, height);
    return await createImageBitmap(canvas, {
      premultiplyAlpha: "premultiply",
      colorSpaceConversion: "none",
    });
  } finally {
    URL.revokeObjectURL(source);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function finite(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function positive(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

function boundedInteger(
  value: number | undefined,
  minimum: number,
  maximum: number,
  fallback: number,
): number {
  const normalized = typeof value === "number" && Number.isFinite(value) ? value : fallback;
  return Math.floor(Math.min(maximum, Math.max(minimum, normalized)));
}
