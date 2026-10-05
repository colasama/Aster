import { afterEach, expect, it, vi } from "vitest";
import { MediaBindingLease } from "./media-binding-lease";
import { preparedRasterIdentity } from "./media-frame-identity";
import { captureMediaPixels } from "./media-pixel-capture";
import { destroyMediaResource, type MediaResource } from "./media-resource";

afterEach(() => vi.unstubAllGlobals());
function fixture(mapAsync: () => Promise<void>, kind: "image" | "video" | "raster" = "image") {
  vi.stubGlobal("GPUTextureUsage", { COPY_SRC: 1 });
  vi.stubGlobal("GPUBufferUsage", { COPY_DST: 1, MAP_READ: 2 });
  vi.stubGlobal("GPUMapMode", { READ: 1 });
  const texture = {
    format: "rgba8unorm-srgb",
    width: 3,
    height: 2,
    usage: 1,
    destroy: vi.fn(),
  } as unknown as GPUTexture;
  const owner: MediaResource = {
    source: "image",
    kind: "image",
    texture,
    textureWidth: 3,
    textureHeight: 2,
    bindGroup: {} as GPUBindGroup,
    mediaIdentity: {
      source: { source_id: "image", content_identity: "generation", media_kind: "image" },
      sample: { kind: "image" },
    },
  };
  if (kind === "video") {
    owner.kind = "video";
    owner.lastUploadedTime = 1.25;
    owner.mediaIdentity = {
      source: { source_id: "video", content_identity: "generation", media_kind: "video" },
      sample: { kind: "image" },
    };
  }
  if (kind === "raster") {
    owner.kind = "text";
    owner.mediaIdentity = preparedRasterIdentity("text", "text", "generation", {
      x: -3,
      y: 2,
      width: 3,
      height: 2,
    });
  }
  const lease = new MediaBindingLease(
    [{ instanceId: "image", resource: owner, binding: owner.bindGroup, requestedTime: 1.3 }],
    "capture",
  );
  const rows = new Uint8Array(512);
  rows.set(new Uint8Array(12).fill(7));
  rows.set(new Uint8Array(12).fill(11), 256);
  const buffer = {
    mapAsync,
    getMappedRange: () => rows.buffer,
    mapState: "mapped",
    unmap: vi.fn(),
    destroy: vi.fn(),
  };
  const device = {
    createBuffer: vi.fn(() => buffer),
    queue: { submit: vi.fn() },
    createCommandEncoder: () => ({ copyTextureToBuffer: vi.fn(), finish: () => ({}) }),
  } as unknown as GPUDevice;
  const frames = lease.resourceMessages.filter((m) => m.kind === "media_frame");
  return { texture, owner, lease, buffer, device, frames };
}
it.each(["image", "video", "raster"] as const)(
  "captures retained %s pixels and exact frame identity after the cache owner retires",
  async (kind) => {
    const f = fixture(async () => {}, kind);
    destroyMediaResource(f.owner);
    try {
      const captured = await captureMediaPixels(f.device, f.lease, f.frames);
      expect(captured[0].frame).toEqual(f.frames[0]);
      expect(captured[0].pixels.bytes).toEqual(
        Uint8Array.from([...new Array(12).fill(7), ...new Array(12).fill(11)]),
      );
      expect(f.texture.destroy).not.toHaveBeenCalled();
      expect(f.buffer.destroy).toHaveBeenCalledOnce();
    } finally {
      f.lease.release();
    }
    expect(f.texture.destroy).toHaveBeenCalledOnce();
  },
);
it("rejects release during mapping and destroys temporary readback resources", async () => {
  let resolve = () => {};
  const f = fixture(
    () =>
      new Promise<void>((r) => {
        resolve = r;
      }),
  );
  const capturing = captureMediaPixels(f.device, f.lease, f.frames);
  f.lease.release();
  resolve();
  await expect(capturing).rejects.toThrow(/released/);
  expect(f.buffer.destroy).toHaveBeenCalledOnce();
  destroyMediaResource(f.owner);
});
it("cleans readback resources when GPU mapping fails", async () => {
  const f = fixture(async () => {
    throw Error("device lost");
  });
  try {
    await expect(captureMediaPixels(f.device, f.lease, f.frames)).rejects.toThrow("device lost");
    expect(f.buffer.destroy).toHaveBeenCalledOnce();
  } finally {
    f.lease.release();
    destroyMediaResource(f.owner);
  }
});
it("keeps an independent capture pin after submission releases and retires its original owner", async () => {
  let resolve = () => {};
  const f = fixture(
    () =>
      new Promise<void>((r) => {
        resolve = r;
      }),
  );
  const retained = f.lease.retainForCapture(f.frames.map((frame) => frame.hash));
  const capturing = captureMediaPixels(f.device, retained, f.frames);
  f.lease.release();
  destroyMediaResource(f.owner);
  expect(f.texture.destroy).not.toHaveBeenCalled();
  resolve();
  try {
    expect((await capturing)[0].frame).toEqual(f.frames[0]);
    expect(f.texture.destroy).not.toHaveBeenCalled();
  } finally {
    retained.release();
  }
  expect(f.texture.destroy).toHaveBeenCalledOnce();
});
