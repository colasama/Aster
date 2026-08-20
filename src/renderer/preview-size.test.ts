import { describe, expect, it } from "vitest";
import { calculatePreviewSize } from "./preview-size";

describe("calculatePreviewSize", () => {
  it.each([
    [1, 1_280, 720, 1],
    [2, 2_560, 1_440, 2],
    [3, 2_560, 1_440, 2],
  ])("bounds a %sx display to %sx%s", (devicePixelRatio, width, height, pixelScale) => {
    expect(
      calculatePreviewSize({
        cssWidth: 1_280,
        cssHeight: 720,
        devicePixelRatio,
        quality: 1,
      }),
    ).toEqual({ width, height, pixelScale });
  });

  it("combines preview quality with the bounded device scale", () => {
    expect(
      calculatePreviewSize({
        cssWidth: 1_280,
        cssHeight: 720,
        devicePixelRatio: 3,
        quality: 0.25,
      }),
    ).toEqual({ width: 640, height: 360, pixelScale: 0.5 });
  });

  it("preserves aspect ratio within the GPU texture limit", () => {
    const result = calculatePreviewSize({
      cssWidth: 10_000,
      cssHeight: 5_000,
      devicePixelRatio: 2,
      quality: 1,
      maxDimension: 8_192,
    });

    expect(result).toEqual({ width: 8_192, height: 4_096, pixelScale: 0.8192 });
  });

  it("sanitizes non-finite layout measurements", () => {
    expect(
      calculatePreviewSize({
        cssWidth: Number.NaN,
        cssHeight: Number.POSITIVE_INFINITY,
        devicePixelRatio: 0,
        quality: -1,
      }),
    ).toEqual({ width: 1, height: 1, pixelScale: 1 });
  });
});
