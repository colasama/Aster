import { object, requirePlan } from "./canonical";

export interface EncodedTextureDescriptor {
  encoding: "png" | "jpeg" | "webp";
  format: "rgba8unorm";
  color_space_conversion: "none";
}

export function validateEncodedTexture(value: unknown): EncodedTextureDescriptor {
  const d = object(value, ["encoding", "format", "color_space_conversion"]);
  requirePlan(
    ["png", "jpeg", "webp"].includes(d.encoding as string) &&
      d.format === "rgba8unorm" &&
      d.color_space_conversion === "none",
    "invalid_resource",
    "Unsupported encoded texture descriptor",
  );
  return d as unknown as EncodedTextureDescriptor;
}

/** Admission checks framing only; consumers must decode and bound the actual image extent. */
export function encodedTextureEncoding(bytes: Uint8Array): EncodedTextureDescriptor["encoding"] {
  requirePlan(
    bytes.length <= 64 * 1024 * 1024,
    "invalid_resource",
    "Encoded texture exceeds 64 MiB",
  );
  if ([137, 80, 78, 71, 13, 10, 26, 10].every((v, i) => bytes[i] === v)) return "png";
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return "jpeg";
  if (
    [82, 73, 70, 70].every((v, i) => bytes[i] === v) &&
    [87, 69, 66, 80].every((v, i) => bytes[i + 8] === v)
  )
    return "webp";
  requirePlan(false, "invalid_resource", "Invalid encoded texture signature");
}
