import { afterEach, expect, it, vi } from "vitest";
import { readRasterBounds } from "../frame-plan/raster-sample";
import type { PreparedTextRaster } from "../text/text-raster-acquisition";
import { mediaFrameMessages } from "./media-frame-identity";
import { MediaGpuRegistry } from "./media-gpu-registry";
import type { MediaResource } from "./media-resource";
import { uploadTextRaster } from "./text-raster-upload";

afterEach(() => vi.unstubAllGlobals());

it("keeps a pinned raster addressable across lookup times and replacement", () => {
  vi.stubGlobal("GPUTextureUsage", { TEXTURE_BINDING: 4, COPY_DST: 2, RENDER_ATTACHMENT: 16 });
  const copy = vi.fn();
  const destination = {
    device: {
      createTexture: () => ({ destroy: vi.fn() }),
      queue: { copyExternalImageToTexture: copy },
    } as unknown as GPUDevice,
    sourceId: "text-layer",
    textureLabel: "prepared text",
    createBindGroup: () => ({}) as GPUBindGroup,
  };
  const prepared: PreparedTextRaster = {
    kind: "raster",
    source: "font-revision-1:time-0",
    signature: "glyph-state-1",
    raster: {
      canvas: {} as HTMLCanvasElement,
      width: 16,
      height: 16,
      bounds: { x: -0, y: -2.25, width: Math.PI, height: 8 },
    },
  };
  const resource = uploadTextRaster(prepared, undefined, destination);
  const messages = mediaFrameMessages(resource, "snapshot");
  const registry = new MediaGpuRegistry();
  registry.apply(messages[0]);
  registry.apply(messages[1], resource, resource.bindGroup);
  const lease = registry.pin([messages[1].hash]);
  expect(readRasterBounds(resource.mediaIdentity?.sample)).toEqual(prepared.raster.bounds);
  uploadTextRaster({ kind: "retained", source: "font-revision-1:time-1" }, resource, destination);
  expect(mediaFrameMessages(resource, "snapshot")).toEqual(messages);
  expect(lease.bindingForHash(messages[1].hash)).toBe(resource.bindGroup);
  expect(copy).toHaveBeenCalledOnce();
  const next = uploadTextRaster(
    { ...prepared, source: "font-revision-2:time-1" },
    resource,
    destination,
  );
  expect(next.texture).not.toBe(resource.texture);
  expect(mediaFrameMessages(next, "snapshot")[1].hash).not.toBe(messages[1].hash);
  expect(lease.bindingForHash(messages[1].hash)).toBe(resource.bindGroup);
  expect(resource.texture?.destroy).not.toHaveBeenCalled();
  lease.release();
  expect(resource.texture?.destroy).toHaveBeenCalledOnce();
  registry.destroy();
});

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
  const destination = {
    device,
    sourceId: "text-layer",
    textureLabel: "supplied raster",
    createBindGroup: vi.fn(),
  };
  expect(() => uploadTextRaster(prepared, existing, destination)).toThrow(failure);
  expect(texture.destroy).toHaveBeenCalledOnce();
  expect(oldTexture.destroy).not.toHaveBeenCalled();
  expect(existing.source).toBe("installed");
  expect(destination.createBindGroup).not.toHaveBeenCalled();
});
