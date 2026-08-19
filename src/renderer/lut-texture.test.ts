import { describe, expect, it } from "vitest";
import { float32ToFloat16, packLutTextureData } from "./lut-texture";

describe("GPU LUT texture packing", () => {
  it("packs RGB rows as filterable RGBA16F voxels", () => {
    expect([...packLutTextureData([0, 0.5, 1])]).toEqual([
      0,
      float32ToFloat16(0.5),
      0x3c00,
      0x3c00,
    ]);
  });

  it("bounds values to the finite half-float range", () => {
    expect(float32ToFloat16(1)).toBe(0x3c00);
    expect(float32ToFloat16(100_000)).toBe(0x7bff);
    expect(float32ToFloat16(-100_000)).toBe(0xfbff);
  });
});
