import { beforeEach, describe, expect, it, vi } from "vitest";
import { frameBundleFixtures } from "../frame-plan/frame-bundle-fixture";
import { readFrameBundle } from "../frame-plan/frame-bundle-read";
import { type ImageRasterDestination, uploadImageRaster } from "./image-raster-upload";
import { SuppliedMediaPixels } from "./supplied-media-pixels";

vi.mock("./image-raster-upload", () => ({ uploadImageRaster: vi.fn() }));
const destination = {
  maximumDimension: 8192,
  maximumBytes: 64 * 1024 * 1024,
} as ImageRasterDestination;

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
  it("allocates derived outputs without uploading their captured resolved pixels", async () => {
    vi.stubGlobal("GPUTextureUsage", { RENDER_ATTACHMENT: 1, TEXTURE_BINDING: 2, COPY_SRC: 4 });
    const captures = readFrameBundle(frameBundleFixtures()[0].frameBundle).mediaPixels;
    const hash = captures[0].frame.hash,
      texture = { destroy: vi.fn() } as unknown as GPUTexture;
    const supplied = await SuppliedMediaPixels.create(
      captures,
      [hash],
      {
        ...destination,
        device: { createTexture: vi.fn(() => texture) } as unknown as GPUDevice,
        createBindGroup: () => ({}) as GPUBindGroup,
      },
      [hash],
    );
    expect(uploadImageRaster).not.toHaveBeenCalled();
    expect(supplied.textureForHash(hash)).toBe(texture);
    supplied.destroy();
    expect(texture.destroy).toHaveBeenCalledOnce();
    expect(() => supplied.textureForHash(hash)).toThrow(/absent or destroyed/);
    vi.unstubAllGlobals();
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
