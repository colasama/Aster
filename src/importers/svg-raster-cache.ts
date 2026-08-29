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
  stamp: number;
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
  #stamp = 0;
  #bytes = 0;

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
      ready.stamp = ++this.#stamp;
      return ready.raster;
    }
    const pending = this.#pending.get(key);
    if (pending) return pending;
    const markup = svgMarkupAtRasterSize(source.sanitized, target.width, target.height);
    const rasterized = this.#rasterize(markup, target.width, target.height).then(
      (raster) => {
        this.#pending.delete(key);
        const bytes = target.width * target.height * 4;
        if (bytes > this.#maxBytes) return raster;
        this.#ready.set(key, { raster, bytes, stamp: ++this.#stamp });
        this.#bytes += bytes;
        this.#evict();
        return raster;
      },
      (error: unknown) => {
        this.#pending.delete(key);
        throw error;
      },
    );
    this.#pending.set(key, rasterized);
    return rasterized;
  }

  clear(): void {
    for (const key of [...this.#ready.keys()]) this.#remove(key);
  }

  #evict(): void {
    while (this.#ready.size > this.#maxEntries || this.#bytes > this.#maxBytes) {
      let oldestKey: string | undefined;
      let oldestStamp = Number.POSITIVE_INFINITY;
      for (const [key, entry] of this.#ready)
        if (entry.stamp < oldestStamp) {
          oldestKey = key;
          oldestStamp = entry.stamp;
        }
      if (!oldestKey) break;
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
  const blob = new Blob([markup], { type: "image/svg+xml" });
  return createImageBitmap(blob, {
    resizeWidth: boundedInteger(width, 1, 32_768, 1),
    resizeHeight: boundedInteger(height, 1, 32_768, 1),
    resizeQuality: "high",
    premultiplyAlpha: "premultiply",
    colorSpaceConversion: "none",
  });
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
