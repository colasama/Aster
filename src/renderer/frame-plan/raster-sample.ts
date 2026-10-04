import { integer, object, requirePlan } from "./canonical";

export interface RasterBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}
export interface RasterSample {
  kind: "raster";
  origin: "text" | "svg" | "psd";
  /** x/y/width/height as IEEE-754 f64, each encoded as two little-endian u32 words. */
  bounds_f64_le: number[];
}

export function readRasterBounds(value: unknown): RasterBounds {
  const sample = object(value, ["kind", "origin", "bounds_f64_le"]);
  requirePlan(
    sample.kind === "raster" && ["text", "svg", "psd"].includes(String(sample.origin)),
    "invalid_resource",
    "Unknown raster origin",
  );
  requirePlan(
    Array.isArray(sample.bounds_f64_le) && sample.bounds_f64_le.length === 8,
    "invalid_resource",
    "Raster bounds require four f64 values",
  );
  const view = new DataView(new ArrayBuffer(32));
  sample.bounds_f64_le.forEach((word, index) => {
    view.setUint32(index * 4, integer(word, 0, 0xffff_ffff), true);
  });
  const values = Array.from({ length: 4 }, (_, index) => view.getFloat64(index * 8, true));
  requirePlan(
    values.every(Number.isFinite) && values[2] > 0 && values[3] > 0,
    "invalid_resource",
    "Raster bounds must be finite with positive extent",
  );
  return { x: values[0], y: values[1], width: values[2], height: values[3] };
}

export function rasterSample(origin: RasterSample["origin"], bounds: RasterBounds): RasterSample {
  const view = new DataView(new ArrayBuffer(32));
  [bounds.x, bounds.y, bounds.width, bounds.height].forEach((value, index) => {
    view.setFloat64(index * 8, value, true);
  });
  const sample: RasterSample = {
    kind: "raster",
    origin,
    bounds_f64_le: Array.from({ length: 8 }, (_, index) => view.getUint32(index * 4, true)),
  };
  readRasterBounds(sample);
  return sample;
}
