import { requirePlan } from "../frame-plan/canonical";
import { encodedTextureEncoding } from "../frame-plan/encoded-texture";
import { contentResourceHash, validateResourceMessage } from "../frame-plan/resources";
import type { PutResource } from "../frame-plan/types";

/** Own immutable compressed image bytes without retaining an authoring source URL. */
export async function prepareEncodedTexture(blob: Blob) {
  requirePlan(
    blob.size > 0 && blob.size <= 64 * 1024 * 1024,
    "invalid_resource",
    "Encoded texture exceeds 64 MiB",
  );
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const content = {
    kind: "encoded_texture" as const,
    descriptor: {
      encoding: encodedTextureEncoding(bytes),
      format: "rgba8unorm" as const,
      color_space_conversion: "none" as const,
    },
  };
  const message: PutResource = {
    type: "put_resource",
    ...content,
    hash: await contentResourceHash(content, bytes),
  };
  return { message, bytes };
}

/** Decode only admitted bytes, retaining the established browser normal-map upload semantics. */
export async function uploadEncodedTexture(
  device: GPUDevice,
  input: PutResource,
  pixels: Uint8Array,
  label: string,
  diagnosticCopySource = false,
) {
  const message = structuredClone(validateResourceMessage(input));
  requirePlan(
    message.type === "put_resource" && message.kind === "encoded_texture",
    "invalid_resource",
    "Expected encoded texture",
  );
  requirePlan(
    pixels.length <= 64 * 1024 * 1024,
    "invalid_resource",
    "Encoded texture exceeds 64 MiB",
  );
  const bytes = new Uint8Array(pixels);
  requirePlan(
    (await contentResourceHash(message, bytes)) === message.hash,
    "hash_mismatch",
    "Encoded texture hash differs",
  );
  const bitmap = await createImageBitmap(
    new Blob([bytes], { type: `image/${message.descriptor.encoding}` }),
    { colorSpaceConversion: "none" },
  );
  let texture: GPUTexture | undefined;
  try {
    const maximum = Math.min(4096, device.limits.maxTextureDimension2D);
    requirePlan(
      bitmap.width >= 1 &&
        bitmap.height >= 1 &&
        bitmap.width <= maximum &&
        bitmap.height <= maximum &&
        bitmap.width * bitmap.height * 4 <= 64 * 1024 * 1024,
      "limit_exceeded",
      "Normal map exceeds the 4096px or 64 MiB limit",
    );
    device.pushErrorScope("validation");
    let validationError: GPUError | null;
    try {
      texture = device.createTexture({
        label,
        size: [bitmap.width, bitmap.height],
        format: message.descriptor.format,
        // Dawn external-image copies may use a render pass.
        usage:
          GPUTextureUsage.TEXTURE_BINDING |
          GPUTextureUsage.COPY_DST |
          GPUTextureUsage.RENDER_ATTACHMENT |
          (diagnosticCopySource ? GPUTextureUsage.COPY_SRC : 0),
      });
      device.queue.copyExternalImageToTexture({ source: bitmap, flipY: false }, { texture }, [
        bitmap.width,
        bitmap.height,
      ]);
    } finally {
      validationError = await device.popErrorScope();
    }
    requirePlan(
      !validationError,
      "invalid_resource",
      `Normal map GPU upload failed: ${validationError?.message}`,
    );
    return { texture, bytes: bitmap.width * bitmap.height * 4 };
  } catch (error) {
    texture?.destroy();
    throw error;
  } finally {
    bitmap.close();
  }
}
