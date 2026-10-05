import { requirePlan } from "../frame-plan/canonical";
import type { BundleResource } from "../frame-plan/precomposition-bundle-resources";
import { contentResourceHashSync } from "../frame-plan/resources";
import type { PutResource } from "../frame-plan/types";

export interface CapturedMediaPixels {
  frame: PutResource;
  pixels: BundleResource;
}

/** Packed installed RGBA bytes; frame identity supplies the sRGB sampling interpretation. */
export function createMediaPixelPayload(
  frame: PutResource,
  input: Uint8Array,
): CapturedMediaPixels {
  const bytes = new Uint8Array(input);
  const content = {
    kind: "buffer" as const,
    descriptor: {
      element_type: "u8" as const,
      element_count: bytes.length,
      byte_length: bytes.length,
    },
  };
  const result = {
    frame: structuredClone(frame),
    pixels: {
      message: {
        type: "put_resource" as const,
        ...content,
        hash: contentResourceHashSync(content, bytes),
      },
      bytes,
    },
  };
  validateMediaPixelPayload(result);
  return result;
}

export function validateMediaPixelPayload({ frame, pixels }: CapturedMediaPixels): void {
  requirePlan(
    frame.kind === "media_frame" &&
      frame.descriptor.format === "rgba8unorm-srgb" &&
      pixels.message.kind === "buffer" &&
      pixels.message.descriptor.element_type === "u8" &&
      pixels.bytes.length === frame.descriptor.width * frame.descriptor.height * 4 &&
      pixels.bytes.length <= 64 * 1024 * 1024,
    "invalid_resource",
    "Media pixels differ from their frame layout",
  );
  requirePlan(
    contentResourceHashSync(frame) === frame.hash &&
      contentResourceHashSync(pixels.message, pixels.bytes) === pixels.message.hash,
    "hash_mismatch",
    "Media pixel payload hash differs",
  );
}
