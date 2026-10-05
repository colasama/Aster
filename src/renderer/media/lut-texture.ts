import { float32ToFloat16 } from "../../core/media/half-float";
import type { Lut3dResource } from "../../core/types";
import { contentResourceHashSync } from "../frame-plan/resources";
import type { PutResource } from "../frame-plan/types";
import { uploadTexturePixels } from "./texture-pixel-upload";

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
  const prepared = prepareLutTexture(resource);
  return uploadTexturePixels(device, prepared.message, prepared.bytes, prepared.label);
}

export function prepareLutTexture(resource?: Lut3dResource) {
  const size = resource?.size ?? 2;
  const packed = packLutTextureData(resource?.data ?? IDENTITY_DATA);
  const bytes = new Uint8Array(packed.byteLength);
  const view = new DataView(bytes.buffer);
  packed.forEach((value, index) => {
    view.setUint16(index * 2, value, true);
  });
  const content = {
    kind: "texture_pixels" as const,
    descriptor: {
      dimension: "3d" as const,
      width: size,
      height: size,
      depth: size,
      format: "rgba16float" as const,
    },
  };
  const message: PutResource = {
    type: "put_resource",
    ...content,
    hash: contentResourceHashSync(content, bytes),
  };
  return { message, bytes, label: resource ? `3D LUT · ${resource.name}` : "Identity 3D LUT" };
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
