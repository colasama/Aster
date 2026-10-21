import type { Layer } from "../../../src/core/types";
import { acquireTextRaster } from "../../../src/renderer/text/text-raster-acquisition";

/** Independent Canvas upload reference at the retained provider's RGBA8 texture boundary. */
export class TextGpuReference {
  #device: Promise<GPUDevice> | undefined;
  readonly #hashes = new Map<string, string>();

  async retained(layer: Layer, sourceTime: number, frameRate: number, scale: number) {
    const prepared = acquireTextRaster(layer, sourceTime, frameRate, scale, 4096);
    if (prepared.kind !== "raster") throw new Error("Fresh text reference retained stale pixels");
    const { raster } = prepared;
    try {
      const pixels = raster.canvas
        .getContext("2d")
        ?.getImageData(0, 0, raster.width, raster.height);
      if (!pixels) throw new Error("Retained text reference pixels unavailable");
      const hash = Array.from(
        new Uint8Array(await crypto.subtle.digest("SHA-256", pixels.data)),
        (b) => b.toString(16).padStart(2, "0"),
      ).join("");
      return {
        source_time: sourceTime,
        frame_rate: frameRate,
        source: prepared.source,
        width: raster.width,
        height: raster.height,
        bounds: raster.bounds,
        rgba_sha256: hash,
        gpu_rgba_sha256: await this.capture(raster.canvas, hash),
      };
    } finally {
      raster.canvas.width = raster.canvas.height = 1;
    }
  }

  async capture(canvas: HTMLCanvasElement, canvasHash: string): Promise<string> {
    const { width, height } = canvas;
    if (width < 1 || height < 1 || width > 4096 || height > 4096)
      throw new Error("Text GPU reference extent exceeds budget");
    const key = `${width}:${height}:${canvasHash}`;
    const cached = this.#hashes.get(key);
    if (cached) return cached;
    this.#device ??= (async () => {
      const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
      if (!adapter) throw new Error("Text GPU reference adapter unavailable");
      return adapter.requestDevice();
    })();
    const device = await this.#device;
    const texture = device.createTexture({
      size: [width, height],
      format: "rgba8unorm-srgb",
      usage:
        GPUTextureUsage.COPY_DST | GPUTextureUsage.COPY_SRC | GPUTextureUsage.RENDER_ATTACHMENT,
    });
    const row = Math.ceil((width * 4) / 256) * 256;
    const buffer = device.createBuffer({
      size: row * height,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
    try {
      device.queue.copyExternalImageToTexture({ source: canvas }, { texture }, [width, height]);
      const encoder = device.createCommandEncoder();
      encoder.copyTextureToBuffer({ texture }, { buffer, bytesPerRow: row }, [width, height]);
      device.queue.submit([encoder.finish()]);
      await buffer.mapAsync(GPUMapMode.READ);
      const mapped = new Uint8Array(buffer.getMappedRange()),
        pixels = new Uint8Array(width * height * 4);
      for (let y = 0; y < height; y++)
        pixels.set(mapped.subarray(y * row, y * row + width * 4), y * width * 4);
      const hash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", pixels)), (b) =>
        b.toString(16).padStart(2, "0"),
      ).join("");
      if (this.#hashes.size >= 100000) this.#hashes.clear();
      this.#hashes.set(key, hash);
      return hash;
    } finally {
      buffer.destroy();
      texture.destroy();
    }
  }
}
