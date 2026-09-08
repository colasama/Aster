import { describe, expect, it, vi } from "vitest";
import { encodeRawFramePng, normalizeRawFrameRgba } from "./raw-frame-png";

describe("canonical raw frame PNG input", () => {
  it("copies packed RGBA without changing channels", () => {
    const source = Uint8Array.from([10, 20, 30, 40, 50, 60, 70, 80]);
    expect(normalizeRawFrameRgba({ pixels: source.buffer, pixelFormat: "rgba" }, 2, 1)).toEqual(
      new Uint8ClampedArray(source),
    );
  });

  it("converts packed BGRA to RGBA while preserving alpha", () => {
    const source = Uint8Array.from([30, 20, 10, 40, 70, 60, 50, 80]);
    expect(normalizeRawFrameRgba({ pixels: source.buffer, pixelFormat: "bgra" }, 2, 1)).toEqual(
      Uint8ClampedArray.from([10, 20, 30, 40, 50, 60, 70, 80]),
    );
  });

  it("feeds PNG encoding from the canonical raw buffer", async () => {
    const encoder = vi.fn(async () => new Blob(["png"], { type: "image/png" }));
    const raw = Uint8Array.from([3, 2, 1, 255]);

    const blob = await encodeRawFramePng(
      { pixels: raw.buffer, pixelFormat: "bgra" },
      1,
      1,
      encoder,
    );

    expect(blob.type).toBe("image/png");
    expect(encoder).toHaveBeenCalledWith(1, 1, Uint8ClampedArray.from([1, 2, 3, 255]));
  });

  it("rejects buffers whose byte length and dimensions disagree", () => {
    expect(() =>
      normalizeRawFrameRgba({ pixels: new ArrayBuffer(7), pixelFormat: "rgba" }, 2, 1),
    ).toThrow("byte length");
  });
});
