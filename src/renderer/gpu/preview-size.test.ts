import { describe, expect, it } from "vitest";
import { calculatePreviewSize } from "./preview-size";

describe("calculatePreviewSize", () => {
  it.each([
    [1, 1_920, 1_080],
    [0.5, 960, 540],
    [0.25, 480, 270],
  ])("renders a composition at quality %s as %sx%s", (quality, width, height) => {
    expect(
      calculatePreviewSize({
        compositionWidth: 1_920,
        compositionHeight: 1_080,
        quality,
      }),
    ).toEqual({ width, height, pixelScale: quality });
  });

  it("rounds fractional dimensions down to at least one pixel", () => {
    expect(
      calculatePreviewSize({
        compositionWidth: 1_921,
        compositionHeight: 3,
        quality: 0.25,
      }),
    ).toEqual({ width: 480, height: 1, pixelScale: 0.25 });
  });

  it("preserves aspect ratio within the GPU texture limit", () => {
    const result = calculatePreviewSize({
      compositionWidth: 10_000,
      compositionHeight: 5_000,
      quality: 1,
      maxDimension: 8_192,
    });

    expect(result).toEqual({ width: 8_192, height: 4_096, pixelScale: 0.8192 });
  });

  it("sanitizes invalid composition dimensions and quality", () => {
    expect(
      calculatePreviewSize({
        compositionWidth: Number.NaN,
        compositionHeight: Number.POSITIVE_INFINITY,
        quality: -1,
      }),
    ).toEqual({ width: 1, height: 1, pixelScale: 1 });
  });
});
