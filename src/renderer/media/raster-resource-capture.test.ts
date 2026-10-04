import { afterEach, expect, it, vi } from "vitest";
import { preparedRasterIdentity } from "./media-frame-identity";
import { destroyMediaResource, type MediaResource } from "./media-resource";
import { captureRasterResources } from "./raster-resource-capture";

afterEach(() => vi.unstubAllGlobals());

it("releases a retained raster when GPU mapping fails and leaves the capture cache unpublished", async () => {
  vi.stubGlobal("GPUBufferUsage", { COPY_DST: 1, MAP_READ: 2 });
  vi.stubGlobal("GPUMapMode", { READ: 1 });
  const texture = { destroy: vi.fn() } as unknown as GPUTexture;
  const owner: MediaResource = {
    source: "prepared",
    kind: "text",
    texture,
    textureWidth: 3,
    textureHeight: 2,
    bindGroup: {} as GPUBindGroup,
    mediaIdentity: preparedRasterIdentity("text", "text", "font-1", {
      x: 0,
      y: 0,
      width: 3,
      height: 2,
    }),
  };
  let reject!: (error: Error) => void;
  const mapped = new Promise<void>((_resolve, rejectMap) => {
    reject = rejectMap;
  });
  const buffer = { destroy: vi.fn(), mapAsync: () => mapped, mapState: "pending" };
  const device = {
    createBuffer: () => buffer,
    queue: { submit: vi.fn() },
    createCommandEncoder: () => ({ copyTextureToBuffer: vi.fn(), finish: () => ({}) }),
  } as unknown as GPUDevice;
  const known = new Map<string, string>();
  const capturing = captureRasterResources(
    device,
    [owner],
    "snapshot",
    known,
    () => ({}) as GPUBindGroup,
  );
  destroyMediaResource(owner);
  expect(texture.destroy).not.toHaveBeenCalled();
  reject(new Error("device lost"));
  await expect(capturing).rejects.toThrow("device lost");
  expect(texture.destroy).toHaveBeenCalledOnce();
  expect(buffer.destroy).toHaveBeenCalledOnce();
  expect(known.size).toBe(0);
});
