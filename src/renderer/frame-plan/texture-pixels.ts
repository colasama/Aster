import { integer, object, requirePlan } from "./canonical";

export interface TexturePixelsDescriptor {
  dimension: "2d" | "3d";
  width: number;
  height: number;
  depth: number;
  format: "rgba8unorm" | "rgba16float";
}

/** Packed rows/layers in little-endian channel order, without implicit padding. */
export function validateTexturePixels(value: unknown): TexturePixelsDescriptor {
  const d = object(value, ["dimension", "width", "height", "depth", "format"]);
  requirePlan(
    (d.dimension === "2d" || d.dimension === "3d") &&
      (d.format === "rgba8unorm" || d.format === "rgba16float"),
    "invalid_resource",
    "Unsupported texture dimension or format",
  );
  const maximum = d.dimension === "2d" ? 8192 : 256;
  const width = integer(d.width, 1, maximum);
  const height = integer(d.height, 1, maximum);
  const depth = integer(d.depth, 1, d.dimension === "2d" ? 1 : maximum);
  requirePlan(
    width * height * depth * (d.format === "rgba16float" ? 8 : 4) <= 256 * 1024 * 1024,
    "invalid_resource",
    "Texture pixels exceed the transport budget",
  );
  return d as unknown as TexturePixelsDescriptor;
}
