import { describe, expect, it, vi } from "vitest";
import { paintText } from "./text-raster-bounds";

describe("text ink bounds", () => {
  it("includes reflected, rotated ink, stroke and blur outside the paragraph", () => {
    const bounds = { x: 0, y: 0, width: 100, height: 50 };
    const context = {
      font: "700 40px sans-serif",
      filter: "blur(4px)",
      lineWidth: 6,
      measureText: () => ({
        width: 20,
        actualBoundingBoxLeft: 2,
        actualBoundingBoxRight: 22,
        actualBoundingBoxAscent: 30,
        actualBoundingBoxDescent: 10,
      }),
      getTransform: () => ({ a: 0, b: -2, c: -1, d: 0, e: 150, f: -40 }),
      fillText: vi.fn(),
      strokeText: vi.fn(),
    } as unknown as CanvasRenderingContext2D;
    paintText(context, "A", 0, 0, true, bounds);
    expect(bounds).toEqual({ x: 0, y: -103, width: 196, height: 153 });
    expect(context.fillText).not.toHaveBeenCalled();
    expect(context.strokeText).not.toHaveBeenCalled();
  });
});
