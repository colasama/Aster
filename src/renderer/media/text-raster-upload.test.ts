import { afterEach, expect, it, vi } from "vitest";
import type { PreparedTextRaster } from "../text/text-raster-acquisition";
import type { MediaResource } from "./media-resource";
import { uploadTextRaster } from "./text-raster-upload";

afterEach(() => vi.unstubAllGlobals());

it("keeps the installed generation when a supplied raster upload fails and destroys its new allocation", () => {
  vi.stubGlobal("GPUTextureUsage", { TEXTURE_BINDING: 4, COPY_DST: 2, RENDER_ATTACHMENT: 16 });
  const oldTexture = { destroy: vi.fn() };
  const texture = { destroy: vi.fn() };
  const existing: MediaResource = {
    kind: "text",
    source: "installed",
    texture: oldTexture as unknown as GPUTexture,
    textureWidth: 1,
    textureHeight: 1,
  };
  const prepared: PreparedTextRaster = {
    kind: "raster",
    source: "next",
    signature: "supplied",
    raster: {
      canvas: {} as HTMLCanvasElement,
      width: 2,
      height: 2,
      bounds: { x: -1, y: 0, width: 2, height: 2 },
    },
  };
  const failure = new Error("upload failed");
  const device = {
    createTexture: () => texture,
    queue: {
      copyExternalImageToTexture: () => {
        throw failure;
      },
    },
  } as unknown as GPUDevice;
  const destination = { device, textureLabel: "supplied raster", createBindGroup: vi.fn() };
  expect(() => uploadTextRaster(prepared, existing, destination)).toThrow(failure);
  expect(texture.destroy).toHaveBeenCalledOnce();
  expect(oldTexture.destroy).not.toHaveBeenCalled();
  expect(existing.source).toBe("installed");
  expect(destination.createBindGroup).not.toHaveBeenCalled();
});
