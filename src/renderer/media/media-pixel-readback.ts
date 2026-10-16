import { alignedReadbackBytesPerRow } from "../gpu/frame-readback";

interface CopyRegion {
  texture: GPUTexture;
  target: Uint8Array;
  y: number;
  rows: number;
  bytesPerRow: number;
  offset: number;
}

/** Pack retained textures into bounded submissions instead of mapping once per raster. */
export async function readRetainedMediaPixels(
  device: GPUDevice,
  textures: readonly GPUTexture[],
): Promise<Uint8Array[]> {
  const capacity =
    Math.floor(Math.min(16 * 1024 * 1024, device.limits?.maxBufferSize ?? 16 * 1024 * 1024) / 256) *
    256;
  const result = textures.map((texture) => new Uint8Array(texture.width * texture.height * 4));
  let regions: CopyRegion[] = [],
    used = 0;
  const flush = async () => {
    if (!used) return;
    const buffer = device.createBuffer({
      label: "Retained media batch readback",
      size: used,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
    try {
      const encoder = device.createCommandEncoder({ label: "Retained media pixel batch" });
      for (const region of regions)
        encoder.copyTextureToBuffer(
          { texture: region.texture, origin: [0, region.y] },
          {
            buffer,
            offset: region.offset,
            bytesPerRow: region.bytesPerRow,
            rowsPerImage: region.rows,
          },
          [region.texture.width, region.rows],
        );
      device.queue.submit([encoder.finish()]);
      await buffer.mapAsync(GPUMapMode.READ);
      const mapped = new Uint8Array(buffer.getMappedRange());
      if (mapped.byteLength !== used) throw new Error("Mapped media readback size differs");
      for (const region of regions) {
        const rowBytes = region.texture.width * 4;
        for (let row = 0; row < region.rows; row++) {
          const offset = region.offset + row * region.bytesPerRow;
          region.target.set(
            mapped.subarray(offset, offset + rowBytes),
            (region.y + row) * rowBytes,
          );
        }
      }
    } finally {
      if (buffer.mapState === "mapped") buffer.unmap();
      buffer.destroy();
    }
    regions = [];
    used = 0;
  };
  for (const [index, texture] of textures.entries()) {
    const bytesPerRow = alignedReadbackBytesPerRow(texture.width);
    if (bytesPerRow > capacity) throw new Error("Media row exceeds bounded readback capacity");
    for (let y = 0; y < texture.height; ) {
      if (capacity - used < bytesPerRow) await flush();
      const rows = Math.min(texture.height - y, Math.floor((capacity - used) / bytesPerRow));
      regions.push({ texture, target: result[index], y, rows, bytesPerRow, offset: used });
      used += rows * bytesPerRow;
      y += rows;
    }
  }
  await flush();
  return result;
}
