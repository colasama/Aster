import { requirePlan } from "../frame-plan/canonical";
import { contentResourceHashSync, validateResourceMessage } from "../frame-plan/resources";
import type { PutResource } from "../frame-plan/types";

/** Upload only validated supplied pixels; authoring objects and source decoders are absent. */
export function uploadTexturePixels(
  device: GPUDevice,
  message: PutResource,
  pixels: Uint8Array,
  label: string,
): GPUTexture {
  validateResourceMessage(message);
  requirePlan(message.kind === "texture_pixels", "invalid_resource", "Expected texture pixels");
  requirePlan(
    contentResourceHashSync(message, pixels) === message.hash,
    "hash_mismatch",
    "Texture pixel hash differs",
  );
  const d = message.descriptor;
  const maximum =
    d.dimension === "3d"
      ? device.limits.maxTextureDimension3D
      : device.limits.maxTextureDimension2D;
  requirePlan(
    Math.max(d.width, d.height, d.depth) <= maximum,
    "limit_exceeded",
    "Texture exceeds the device dimension limit",
  );
  const texture = device.createTexture({
    label,
    size: [d.width, d.height, d.depth],
    dimension: d.dimension,
    format: d.format,
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  });
  try {
    device.queue.writeTexture(
      { texture },
      pixels,
      { bytesPerRow: d.width * (d.format === "rgba16float" ? 8 : 4), rowsPerImage: d.height },
      { width: d.width, height: d.height, depthOrArrayLayers: d.depth },
    );
    return texture;
  } catch (error) {
    texture.destroy();
    throw error;
  }
}
