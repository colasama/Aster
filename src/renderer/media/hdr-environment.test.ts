import { describe, expect, it } from "vitest";
import { decodeRadianceHdrForUpload } from "../../core/media/hdr-environment";

const encoder = new TextEncoder();

describe("Radiance HDR environment decoding", () => {
  it("decodes directly into row-aligned linear rgba16float", () => {
    const header = encoder.encode("#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n-Y 1 +X 2\n");
    const source = new Uint8Array(header.length + 8);
    source.set(header);
    source.set([128, 64, 32, 130, 16, 32, 64, 129], header.length);
    const decoded = decodeRadianceHdrForUpload(source);
    expect(decoded).toMatchObject({ width: 2, height: 1, bytesPerRow: 256 });
    expect(Array.from(decoded.pixels?.slice(0, 8) ?? [])).toEqual([
      0x4000, 0x3c00, 0x3800, 0x3c00, 0x3000, 0x3400, 0x3800, 0x3c00,
    ]);
    expect(decoded.pixels?.byteLength).toBe(256);
  });

  it("decodes channel-major RLE into the final upload payload", () => {
    const header = encoder.encode("#?RGBE\nFORMAT=32-bit_rle_rgbe\n\n-Y 1 +X 8\n");
    const scanline = new Uint8Array([2, 2, 0, 8, 136, 64, 136, 32, 136, 16, 136, 129]);
    const source = new Uint8Array(header.length + scanline.length);
    source.set(header);
    source.set(scanline, header.length);
    const decoded = decodeRadianceHdrForUpload(source);
    expect(decoded.pixels?.[0]).toBe(0x3800);
    expect(decoded.bytesPerRow).toBe(256);
  });

  it("rejects unsupported orientations and excessive dimensions before allocation", () => {
    expect(() =>
      decodeRadianceHdrForUpload(
        encoder.encode("#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n+Y 1 +X 1\n\0\0\0\0"),
      ),
    ).toThrow("orientation");
    expect(() =>
      decodeRadianceHdrForUpload(
        encoder.encode("#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n-Y 4097 +X 8192\n"),
      ),
    ).toThrow("dimensions");
  });

  it("validates every scanline without allocating an upload payload", () => {
    const header = encoder.encode("#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n-Y 1 +X 1\n");
    const source = new Uint8Array(header.length + 4);
    source.set(header);
    source.set([1, 2, 3, 128], header.length);
    expect(decodeRadianceHdrForUpload(source, true)).toEqual({
      width: 1,
      height: 1,
      bytesPerRow: 256,
      pixels: undefined,
    });
  });
});
