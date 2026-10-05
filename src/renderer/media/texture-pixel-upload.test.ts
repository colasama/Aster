import { afterEach, expect, it, vi } from "vitest";
import { texturePixelFixtures } from "../frame-plan/texture-pixel-fixture";
import { uploadTexturePixels } from "./texture-pixel-upload";

afterEach(() => vi.unstubAllGlobals());
it("uploads owned prepared pixels and rejects descriptor/hash corruption before allocation", () => {
  vi.stubGlobal("GPUTextureUsage", { TEXTURE_BINDING: 1, COPY_DST: 2 });
  const device = {
    limits: { maxTextureDimension2D: 8192, maxTextureDimension3D: 256 },
    createTexture: vi.fn(() => ({ destroy: vi.fn() })),
    queue: { writeTexture: vi.fn() },
  } as unknown as GPUDevice;
  for (const fixture of texturePixelFixtures()) {
    const message = structuredClone(fixture.message);
    const bytes = new Uint8Array(fixture.bytes);
    uploadTexturePixels(device, message, bytes, fixture.label);
    const calls = vi.mocked(device.queue.writeTexture).mock.calls;
    expect(calls[calls.length - 1][1]).toEqual(fixture.bytes);
    const count = vi.mocked(device.createTexture).mock.calls.length;
    bytes[0] ^= 1;
    expect(() => uploadTexturePixels(device, message, bytes, fixture.label)).toThrow("hash");
    Object.assign(message.descriptor, { format: "rgba32float" });
    expect(() => uploadTexturePixels(device, message, fixture.bytes, fixture.label)).toThrow();
    expect(device.createTexture).toHaveBeenCalledTimes(count);
  }
});
