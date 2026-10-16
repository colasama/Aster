import { requirePlan } from "../frame-plan/canonical";
import { contentResourceHashSync } from "../frame-plan/resources";
import type { PutResource } from "../frame-plan/types";
import type { MediaGpuLease } from "./media-gpu-registry";
import { captureMediaPixels } from "./media-pixel-capture";
import type { CapturedMediaPixels } from "./media-pixel-payload";
import { VerifiedMediaPixels } from "./verified-media-pixels";

/** Reuse immutable native raster inputs while their exact retained texture generation survives. */
export class NativeRasterCaptureCache {
  readonly #entries = new Map<string, { texture: GPUTexture; pixels: VerifiedMediaPixels }>();
  #bytes = 0;
  #epoch = 0;

  constructor(
    readonly maxBytes = 16 * 1024 * 1024,
    readonly maxEntries = 256,
  ) {
    requirePlan(
      Number.isSafeInteger(maxBytes) &&
        maxBytes >= 0 &&
        Number.isSafeInteger(maxEntries) &&
        maxEntries >= 0,
      "invalid_resource",
      "Invalid native raster capture budget",
    );
  }

  get statistics() {
    return { bytes: this.#bytes, entries: this.#entries.size };
  }

  clear(): void {
    this.#entries.clear();
    this.#bytes = 0;
    this.#epoch++;
  }

  async capture(
    device: GPUDevice,
    lease: Pick<MediaGpuLease, "textureForHash">,
    input: readonly PutResource[],
  ): Promise<CapturedMediaPixels[]> {
    return (await this.captureVerified(device, lease, input)).map(VerifiedMediaPixels.copy);
  }

  async captureVerified(
    device: GPUDevice,
    lease: Pick<MediaGpuLease, "textureForHash">,
    input: readonly PutResource[],
  ): Promise<VerifiedMediaPixels[]> {
    const frames = structuredClone(input),
      epoch = this.#epoch;
    const textures = new Map<string, GPUTexture>(),
      hits = new Map<string, VerifiedMediaPixels>();
    let bytes = 0;
    for (const frame of frames) {
      requirePlan(
        frame.kind === "media_frame" &&
          frame.descriptor.sample.kind === "raster" &&
          !textures.has(frame.hash) &&
          contentResourceHashSync(frame) === frame.hash,
        "invalid_resource",
        "Native raster capture requires unique authenticated raster frames",
      );
      bytes += frame.descriptor.width * frame.descriptor.height * 4;
      const texture = lease.textureForHash(frame.hash);
      textures.set(frame.hash, texture);
      const cached = this.#entries.get(frame.hash);
      if (cached?.texture === texture) hits.set(frame.hash, cached.pixels);
    }
    requirePlan(
      frames.length <= 65536 && bytes <= 64 * 1024 * 1024,
      "resource_budget_exceeded",
      "Native raster capture exceeds frame budget",
    );
    const captured = await captureMediaPixels(
      device,
      lease,
      frames.filter((f) => !hits.has(f.hash)),
    );
    const values = new Map(hits);
    for (let first = 0; first < captured.length; first += 32) {
      const results = await Promise.allSettled(
        captured.slice(first, first + 32).map(VerifiedMediaPixels.verify),
      );
      for (const result of results) {
        if (result.status === "rejected") throw result.reason;
        values.set(VerifiedMediaPixels.frameHash(result.value), result.value);
      }
    }
    requirePlan(
      values.size === frames.length && frames.every((frame) => values.has(frame.hash)),
      "missing_resource",
      "Native raster capture coverage differs",
    );
    for (const [hash, texture] of textures)
      requirePlan(
        lease.textureForHash(hash) === texture,
        "resource_generation_mismatch",
        "Native raster changed during capture",
      );
    // Publish only after every read succeeded. Disposal invalidates pending cache writes.
    if (this.#epoch === epoch)
      for (const frame of frames) {
        const pixels = values.get(frame.hash);
        requirePlan(pixels, "missing_resource", "Native raster pixels are absent");
        const previous = this.#entries.get(frame.hash);
        if (previous) {
          this.#bytes -= VerifiedMediaPixels.byteLength(previous.pixels);
          this.#entries.delete(frame.hash);
        }
        const size = VerifiedMediaPixels.byteLength(pixels);
        if (size > this.maxBytes || !this.maxEntries) continue;
        while (this.#bytes + size > this.maxBytes || this.#entries.size >= this.maxEntries) {
          const oldest = this.#entries.entries().next().value;
          if (!oldest) break;
          this.#entries.delete(oldest[0]);
          this.#bytes -= VerifiedMediaPixels.byteLength(oldest[1].pixels);
        }
        this.#entries.set(frame.hash, { texture: textures.get(frame.hash) as GPUTexture, pixels });
        this.#bytes += size;
      }
    return frames.map((frame) => values.get(frame.hash) as VerifiedMediaPixels);
  }
}
