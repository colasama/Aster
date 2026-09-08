import { float32ToFloat16 } from "../../core/media/half-float";
import type { Lut3dResource } from "../../core/types";

export { float32ToFloat16 };

const IDENTITY_DATA = [0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0, 0, 0, 1, 1, 0, 1, 0, 1, 1, 1, 1, 1];

export function createLutSampler(device: GPUDevice): GPUSampler {
  return device.createSampler({
    label: "3D LUT trilinear sampler",
    magFilter: "linear",
    minFilter: "linear",
  });
}

export function createLutTexture(device: GPUDevice, resource?: Lut3dResource): GPUTexture {
  const size = resource?.size ?? 2;
  const texture = device.createTexture({
    label: resource ? `3D LUT · ${resource.name}` : "Identity 3D LUT",
    size: [size, size, size],
    dimension: "3d",
    format: "rgba16float",
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  });
  device.queue.writeTexture(
    { texture },
    packLutTextureData(resource?.data ?? IDENTITY_DATA),
    { bytesPerRow: size * 8, rowsPerImage: size },
    { width: size, height: size, depthOrArrayLayers: size },
  );
  return texture;
}

export function packLutTextureData(rgb: number[]): Uint16Array {
  if (rgb.length % 3 !== 0) throw new Error("LUT data must contain RGB triplets");
  const rgba = new Uint16Array((rgb.length / 3) * 4);
  for (let source = 0, destination = 0; source < rgb.length; source += 3, destination += 4) {
    rgba[destination] = float32ToFloat16(rgb[source]);
    rgba[destination + 1] = float32ToFloat16(rgb[source + 1]);
    rgba[destination + 2] = float32ToFloat16(rgb[source + 2]);
    rgba[destination + 3] = 0x3c00;
  }
  return rgba;
}
