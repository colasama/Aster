import { describe, expect, it } from "vitest";
import { measurePreviewPixels } from "./render-preview";

describe("agent render preview metrics", () => {
  it("detects empty frames and computes bounded luminance", () => {
    const metrics = measurePreviewPixels(new Uint8ClampedArray([0, 0, 0, 0, 0, 0, 0, 0]));
    expect(metrics.emptyFrame).toBe(true);
    expect(metrics.averageLuminance).toBe(0);
    expect(metrics.visiblePixelRatio).toBe(0);
  });

  it("computes frame difference without claiming subjective quality", () => {
    const previous = new Uint8ClampedArray([0, 0, 0, 255]);
    const metrics = measurePreviewPixels(new Uint8ClampedArray([255, 255, 255, 255]), previous);
    expect(metrics.emptyFrame).toBe(false);
    expect(metrics.averageLuminance).toBeCloseTo(1);
    expect(metrics.differenceFromPrevious).toBeCloseTo(0.75);
  });
});
