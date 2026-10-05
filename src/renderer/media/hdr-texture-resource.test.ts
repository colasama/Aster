import { expect, it } from "vitest";
import { texturePixelFixtures } from "../frame-plan/texture-pixel-fixture";
import { prepareHdrTexture } from "./hdr-texture-resource";

it("packs actual decoded HDR rows and owns exact little-endian half-float texels", () => {
  const fixture = texturePixelFixtures().find((f) => f.id === "hdr-worker-padded");
  expect(fixture?.bytes).toEqual(
    new Uint8Array([0, 64, 0, 60, 0, 56, 0, 60, 0, 52, 0, 56, 0, 60, 0, 60]),
  );
  const pixels = new Uint16Array(256);
  pixels.set([0x8000, 1, 0x7bff, 0x3c00]);
  pixels.set([0x3555, 0xbc00, 0x0400, 0], 128);
  const a = prepareHdrTexture({ width: 1, height: 2, bytesPerRow: 256, pixels });
  pixels.fill(0xffff, 4, 128);
  expect(prepareHdrTexture({ width: 1, height: 2, bytesPerRow: 256, pixels })).toEqual(a);
  expect(Array.from(new Uint16Array(a.bytes.buffer))).toEqual([
    0x8000, 1, 0x7bff, 0x3c00, 0x3555, 0xbc00, 0x0400, 0,
  ]);
  pixels.fill(0);
  expect(a.bytes.some((v) => v !== 0)).toBe(true);
});

it("rejects malformed worker extents and row layouts before packing", () => {
  for (const decoded of [
    { width: 1, height: 1, bytesPerRow: 256, pixels: undefined },
    { width: 1, height: 1, bytesPerRow: 7, pixels: new Uint16Array(4) },
    { width: 2, height: 1, bytesPerRow: 8, pixels: new Uint16Array(4) },
    { width: 1, height: 2, bytesPerRow: 256, pixels: new Uint16Array(128) },
    { width: 8193, height: 1, bytesPerRow: 8, pixels: new Uint16Array(4) },
  ]) {
    expect(() => prepareHdrTexture(decoded)).toThrow();
  }
});
