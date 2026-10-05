import { beforeEach, describe, expect, it, vi } from "vitest";
import { frameBundleFixtures } from "../frame-plan/frame-bundle-fixture";
import { readFrameBundle } from "../frame-plan/frame-bundle-read";
import { type ImageRasterDestination, uploadImageRaster } from "./image-raster-upload";
import { SuppliedMediaPixels } from "./supplied-media-pixels";

vi.mock("./image-raster-upload", () => ({ uploadImageRaster: vi.fn() }));
const destination = { maximumBytes: 64 * 1024 * 1024 } as ImageRasterDestination;

describe("supplied frame media ownership", () => {
  beforeEach(() => vi.resetAllMocks());
  it("snapshots asynchronous inputs and rejects missing bindings after retirement", async () => {
    const captures = readFrameBundle(frameBundleFixtures()[0].frameBundle).mediaPixels;
    const expected = captures[0].pixels.bytes.slice(),
      hash = captures[0].frame.hash;
    const destroy = vi.fn(),
      binding = {} as GPUBindGroup;
    vi.mocked(uploadImageRaster).mockReturnValue({
      texture: { destroy } as unknown as GPUTexture,
      bindGroup: binding,
    });
    const pending = SuppliedMediaPixels.create(captures, [hash], destination);
    captures[0].pixels.bytes.fill(0);
    const supplied = await pending;
    expect(vi.mocked(uploadImageRaster).mock.calls[0][0]).toMatchObject({
      bytes: new Uint8ClampedArray(expected),
    });
    expect(supplied.bindingForHash(hash)).toBe(binding);
    expect(supplied.bindingForHash(null)).toBeUndefined();
    expect(() => supplied.bindingForHash(undefined)).toThrow(/hash is absent/);
    supplied.destroy();
    expect(destroy).toHaveBeenCalledOnce();
    expect(() => supplied.bindingForHash(hash)).toThrow(/absent or destroyed/);
  });
  it("rejects corruption, incomplete coverage and over-budget frames before upload", async () => {
    const captures = readFrameBundle(frameBundleFixtures()[0].frameBundle).mediaPixels;
    const required = captures.map((capture) => capture.frame.hash);
    await expect(SuppliedMediaPixels.create(captures, [], destination)).rejects.toThrow(
      /incomplete/,
    );
    await expect(
      SuppliedMediaPixels.create(captures, required, { ...destination, maximumBytes: 1 }),
    ).rejects.toThrow(/budget/);
    captures[0].pixels.bytes[0] ^= 1;
    await expect(SuppliedMediaPixels.create(captures, required, destination)).rejects.toThrow(
      /hash differs/,
    );
    expect(uploadImageRaster).not.toHaveBeenCalled();
  });
  it("releases an uploaded texture when its binding is missing", async () => {
    const captures = readFrameBundle(frameBundleFixtures()[0].frameBundle).mediaPixels;
    const destroy = vi.fn();
    vi.mocked(uploadImageRaster).mockReturnValue({ texture: { destroy } as unknown as GPUTexture });
    await expect(
      SuppliedMediaPixels.create(
        captures,
        captures.map((capture) => capture.frame.hash),
        destination,
      ),
    ).rejects.toThrow(/binding is absent/);
    expect(destroy).toHaveBeenCalledOnce();
  });
});
