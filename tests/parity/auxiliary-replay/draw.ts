import type { AuxiliaryBufferRenderer } from "../../../src/renderer/gpu/auxiliary-buffer-renderer";
import { AUXILIARY_BUFFER_DESCRIPTORS } from "../../../src/renderer/gpu/render-buffers";

/** Readback capability is added only to test allocations; rendering descriptors are unchanged. */
export function observableDevice(device: GPUDevice): GPUDevice {
  return new Proxy(device, {
    get(target, key) {
      if (key === "createTexture")
        return (d: GPUTextureDescriptor) =>
          target.createTexture({
            ...d,
            usage: d.usage | (d.format.startsWith("depth") ? 0 : GPUTextureUsage.COPY_SRC),
          });
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
export function imageLayout(device: GPUDevice) {
  return device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } },
      { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: { type: "filtering" } },
    ],
  });
}
export async function readAuxiliary(
  device: GPUDevice,
  renderer: Pick<
    AuxiliaryBufferRenderer,
    | "textures"
    | "transparentWorldPosition"
    | "frontLayerColor"
    | "peeledWorldPosition"
    | "peeledLayerColor"
  >,
  tier: number,
) {
  const targets: { name: string; texture: GPUTexture; bpp: number }[] = [...renderer.textures].map(
    ([name, texture]) => ({ name, texture, bpp: AUXILIARY_BUFFER_DESCRIPTORS[name].bytesPerPixel }),
  );
  if (tier >= 1)
    targets.push(
      { name: "aggregate", texture: renderer.transparentWorldPosition as GPUTexture, bpp: 8 },
      { name: "frontColor", texture: renderer.frontLayerColor as GPUTexture, bpp: 8 },
    );
  if (tier >= 2)
    targets.push(
      { name: "peeledPosition", texture: renderer.peeledWorldPosition as GPUTexture, bpp: 8 },
      { name: "peeledColor", texture: renderer.peeledLayerColor as GPUTexture, bpp: 8 },
    );
  const encoder = device.createCommandEncoder(),
    buffers = targets.map((t) => {
      const buffer = device.createBuffer({
        size: 64 * 48 * t.bpp,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
      });
      encoder.copyTextureToBuffer(
        { texture: t.texture },
        { buffer, bytesPerRow: 64 * t.bpp, rowsPerImage: 48 },
        [64, 48],
      );
      return buffer;
    });
  device.queue.submit([encoder.finish()]);
  try {
    return await Promise.all(
      buffers.map(async (buffer, i) => {
        await buffer.mapAsync(GPUMapMode.READ);
        return {
          name: targets[i].name,
          bpp: targets[i].bpp,
          bytes: Array.from(new Uint8Array(buffer.getMappedRange())),
        };
      }),
    );
  } finally {
    for (const b of buffers) {
      b.unmap();
      b.destroy();
    }
  }
}
