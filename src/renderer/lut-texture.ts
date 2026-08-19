import type { Lut3dResource } from "../core/types";

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

export function float32ToFloat16(value: number): number {
  const bounded = Math.max(-65504, Math.min(65504, value));
  const source = new Float32Array([bounded]);
  const bits = new Uint32Array(source.buffer)[0];
  const sign = (bits >>> 16) & 0x8000;
  const exponent = ((bits >>> 23) & 0xff) - 127 + 15;
  const mantissa = bits & 0x7fffff;
  if (exponent <= 0) {
    if (exponent < -10) return sign;
    return sign | ((mantissa | 0x800000) >>> (14 - exponent));
  }
  if (exponent >= 31) return sign | 0x7bff;
  return sign | (exponent << 10) | (mantissa >>> 13);
}
