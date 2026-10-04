import { hash, integer, object, requirePlan } from "./canonical";

export interface RasterPixelsDescriptor {
  frame: string;
  width: number;
  height: number;
  format: "rgba8unorm-srgb";
}

/** Tightly packed stored texture values, with no color or alpha conversion on replay. */
export function validateRasterPixels(value: unknown): RasterPixelsDescriptor {
  const raster = object(value, ["frame", "width", "height", "format"]);
  hash(raster.frame);
  integer(raster.width, 1, 16384);
  integer(raster.height, 1, 16384);
  requirePlan(raster.format === "rgba8unorm-srgb", "invalid_resource", "Unsupported raster format");
  return raster as unknown as RasterPixelsDescriptor;
}
