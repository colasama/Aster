import UTIF from "utif";
import { afterEach, describe, expect, it, vi } from "vitest";
import { decodeRasterImage, readRasterImageMetadata } from "./raster-image-decoder";
import { decodeTiffRgba, isTiffSource } from "./tiff-decoder";

afterEach(() => vi.unstubAllGlobals());

describe("TIFF raster decoding", () => {
  it("decodes classic TIFF pixels and dimensions without browser codec support", () => {
    const source = Uint8Array.from([255, 0, 0, 255, 0, 128, 255, 64]);
    const encoded = UTIF.encodeImage(source.buffer, 2, 1);

    const decoded = decodeTiffRgba(encoded);

    expect(decoded.width).toBe(2);
    expect(decoded.height).toBe(1);
    expect([...decoded.pixels]).toEqual([...source]);
  });

  it("routes both TIFF extensions and MIME aliases to the fallback", () => {
    expect(isTiffSource("plate.tif")).toBe(true);
    expect(isTiffSource("plate.TIFF")).toBe(true);
    expect(isTiffSource("plate.bin", "image/tiff")).toBe(true);
    expect(isTiffSource("plate.bin", "image/x-tiff")).toBe(true);
    expect(isTiffSource("plate.avif", "image/avif")).toBe(false);
  });

  it("expands multi-strip 2×2 YCbCr samples instead of returning transparent pixels", () => {
    const decoded = decodeTiffRgba(yCbCrTiff());

    expect(decoded).toMatchObject({ width: 2, height: 4 });
    expect([...decoded.pixels]).toEqual([
      10, 10, 10, 255, 20, 20, 20, 255, 30, 30, 30, 255, 40, 40, 40, 255, 50, 50, 50, 255, 60, 60,
      60, 255, 70, 70, 70, 255, 80, 80, 80, 255,
    ]);
  });

  it("validates TIFF metadata off the UI thread boundary and rejects malformed payloads", async () => {
    vi.stubGlobal("Worker", undefined);
    const nativeDecode = vi.fn();
    vi.stubGlobal("createImageBitmap", nativeDecode);
    const source = Uint8Array.from([20, 30, 40, 255]);
    const encoded = UTIF.encodeImage(source.buffer, 1, 1);

    await expect(
      readRasterImageMetadata(new Blob([encoded], { type: "image/tiff" }), {
        name: "fixture.tiff",
      }),
    ).resolves.toEqual({ width: 1, height: 1 });
    expect(nativeDecode).not.toHaveBeenCalled();
    await expect(
      readRasterImageMetadata(new Blob([Uint8Array.from([0, 1, 2, 3])]), {
        name: "broken.tif",
      }),
    ).rejects.toThrow("truncated");
  });

  it("converts TIFF RGBA to an ImageBitmap while preserving native AVIF decoding", async () => {
    vi.stubGlobal("Worker", undefined);
    const bitmap = { width: 1, height: 1, close: vi.fn() } as unknown as ImageBitmap;
    class MockImageData {
      constructor(
        readonly data: Uint8ClampedArray,
        readonly width: number,
        readonly height: number,
      ) {}
    }
    vi.stubGlobal("ImageData", MockImageData);
    const decodedSources: unknown[] = [];
    const createBitmap = vi.fn(async (source: unknown) => {
      decodedSources.push(source);
      return bitmap;
    });
    vi.stubGlobal("createImageBitmap", createBitmap);
    const encoded = UTIF.encodeImage(Uint8Array.from([2, 4, 8, 255]).buffer, 1, 1);

    await expect(
      decodeRasterImage(new Blob([encoded], { type: "image/tiff" }), { name: "plate.tif" }),
    ).resolves.toBe(bitmap);
    expect(decodedSources[0]).toBeInstanceOf(MockImageData);

    const avif = new Blob([Uint8Array.from([1])], { type: "image/avif" });
    await expect(decodeRasterImage(avif, { name: "plate.avif" })).resolves.toBe(bitmap);
    expect(decodedSources[1]).toBe(avif);
  });
});

function yCbCrTiff(): ArrayBuffer {
  const entryCount = 11;
  const firstIfdOffset = 20;
  const ifdBytes = 2 + entryCount * 12 + 4;
  const bitsOffset = firstIfdOffset + ifdBytes;
  const stripOffsetsOffset = bitsOffset + 6;
  const stripByteCountsOffset = stripOffsetsOffset + 8;
  const bytes = new ArrayBuffer(stripByteCountsOffset + 8);
  const view = new DataView(bytes);
  const payload = new Uint8Array(bytes);
  payload.set([0x49, 0x49, 42, 0], 0);
  view.setUint32(4, firstIfdOffset, true);
  payload.set([10, 20, 30, 40, 128, 128], 8);
  payload.set([50, 60, 70, 80, 128, 128], 14);
  view.setUint16(firstIfdOffset, entryCount, true);
  let entryOffset = firstIfdOffset + 2;
  const entry = (tag: number, type: number, count: number, value: number): void => {
    view.setUint16(entryOffset, tag, true);
    view.setUint16(entryOffset + 2, type, true);
    view.setUint32(entryOffset + 4, count, true);
    if (type === 3 && count === 1) view.setUint16(entryOffset + 8, value, true);
    else view.setUint32(entryOffset + 8, value, true);
    entryOffset += 12;
  };
  entry(256, 3, 1, 2);
  entry(257, 3, 1, 4);
  entry(258, 3, 3, bitsOffset);
  entry(259, 3, 1, 1);
  entry(262, 3, 1, 6);
  entry(273, 4, 2, stripOffsetsOffset);
  entry(277, 3, 1, 3);
  entry(278, 4, 1, 2);
  entry(279, 4, 2, stripByteCountsOffset);
  entry(284, 3, 1, 1);
  entry(530, 3, 2, 2 | (2 << 16));
  view.setUint32(entryOffset, 0, true);
  for (let offset = bitsOffset; offset < bitsOffset + 6; offset += 2)
    view.setUint16(offset, 8, true);
  view.setUint32(stripOffsetsOffset, 8, true);
  view.setUint32(stripOffsetsOffset + 4, 14, true);
  view.setUint32(stripByteCountsOffset, 6, true);
  view.setUint32(stripByteCountsOffset + 4, 6, true);
  return bytes;
}
