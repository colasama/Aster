import { requirePlan } from "../frame-plan/canonical";
import { contentResourceHash } from "../frame-plan/resources";
import { type ImageRasterDestination, uploadImageRaster } from "./image-raster-upload";
import {
  type CapturedMediaPixels,
  validateMediaPixelLayout,
  validateMediaPixelPayload,
} from "./media-pixel-payload";

/** GPU bindings reconstructed solely from content-checked installed pixel generations. */
export class SuppliedMediaPixels {
  readonly #bindings = new Map<string, GPUBindGroup>();
  readonly #textures: GPUTexture[] = [];
  constructor(
    captures: readonly CapturedMediaPixels[],
    required: readonly string[],
    destination: ImageRasterDestination,
  ) {
    for (const capture of captures) validateMediaPixelPayload(capture);
    this.#install(captures, required, destination);
  }

  static async create(
    captures: readonly CapturedMediaPixels[],
    required: readonly string[],
    destination: ImageRasterDestination,
  ): Promise<SuppliedMediaPixels> {
    const owned = structuredClone(captures),
      hashes = [...required];
    for (const capture of owned) {
      validateMediaPixelLayout(capture);
      requirePlan(
        (await contentResourceHash(capture.frame)) === capture.frame.hash &&
          (await contentResourceHash(capture.pixels.message, capture.pixels.bytes)) ===
            capture.pixels.message.hash,
        "hash_mismatch",
        "Supplied media payload hash differs",
      );
    }
    const result = new SuppliedMediaPixels([], [], destination);
    result.#install(owned, hashes, destination);
    return result;
  }

  #install(
    captures: readonly CapturedMediaPixels[],
    required: readonly string[],
    destination: ImageRasterDestination,
  ): void {
    const frames = new Set<string>();
    let bytes = 0;
    for (const capture of captures) {
      validateMediaPixelLayout(capture);
      requirePlan(
        !frames.has(capture.frame.hash),
        "resource_conflict",
        "Duplicate captured media frame",
      );
      frames.add(capture.frame.hash);
      bytes += capture.pixels.bytes.length;
    }
    requirePlan(
      bytes <= destination.maximumBytes,
      "resource_budget_exceeded",
      "Supplied media exceeds GPU budget",
    );
    requirePlan(
      frames.size === new Set(required).size && required.every((hash) => frames.has(hash)),
      "missing_resource",
      "Supplied media pixels are incomplete",
    );
    try {
      for (const { frame, pixels } of captures) {
        if (frame.kind !== "media_frame") throw Error("Invalid supplied media frame");
        const { width, height } = frame.descriptor;
        const uploaded = uploadImageRaster(
          {
            kind: "rgba",
            bytes: new Uint8ClampedArray(pixels.bytes),
            width,
            height,
            layout: { offset: 0, bytesPerRow: width * 4, rowsPerImage: height },
          },
          destination,
        );
        if (uploaded.texture) this.#textures.push(uploaded.texture);
        requirePlan(uploaded.bindGroup, "missing_resource", "Supplied media binding is absent");
        this.#bindings.set(frame.hash, uploaded.bindGroup);
      }
    } catch (error) {
      this.destroy();
      throw error;
    }
  }
  bindingForHash(hash: string | null | undefined): GPUBindGroup | undefined {
    if (hash === null) return undefined;
    requirePlan(hash !== undefined, "missing_resource", "Supplied media hash is absent");
    const binding = this.#bindings.get(hash);
    requirePlan(binding, "missing_resource", "Supplied media frame is absent or destroyed");
    return binding;
  }
  destroy(): void {
    for (const texture of this.#textures) texture.destroy();
    this.#textures.length = 0;
    this.#bindings.clear();
  }
}
