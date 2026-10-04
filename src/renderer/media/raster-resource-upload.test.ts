import { afterEach, expect, it, vi } from "vitest";
import { rasterPixelFixtures } from "../frame-plan/raster-pixel-fixture";
import { FrameResourceRegistry } from "../frame-plan/resources";
import { MediaGpuRegistry } from "./media-gpu-registry";
import { destroyMediaResource } from "./media-resource";
import { uploadRasterResource } from "./raster-resource-upload";

afterEach(() => vi.unstubAllGlobals());

it.each([0, 1, 2])(
  "uploads raster origin %i solely from a decoded resource registry",
  async (index) => {
    vi.stubGlobal("GPUTextureUsage", { TEXTURE_BINDING: 1, COPY_DST: 2, RENDER_ATTACHMENT: 8 });
    const fixture = (await rasterPixelFixtures())[index];
    const registry = new FrameResourceRegistry({ budget_bytes: 100000, max_resources: 10 });
    for (const message of JSON.parse(
      JSON.stringify([fixture.source, fixture.frame, fixture.message]),
    ))
      await registry.apply(message, message.kind === "raster_pixels" ? fixture.bytes : undefined);
    const expected = fixture.bytes.slice();
    fixture.bytes.fill(0); // The producing pixels are no longer available.
    const writeTexture = vi.fn();
    const texture = { destroy: vi.fn() } as unknown as GPUTexture;
    const destination = {
      device: {
        createTexture: vi.fn(() => texture),
        queue: { writeTexture },
      } as unknown as GPUDevice,
      maximumDimension: 8192,
      maximumBytes: 1024 * 1024,
      label: "Decoded raster",
      createBindGroup: () => ({}) as GPUBindGroup,
    };
    const installed = uploadRasterResource(
      registry,
      fixture.message.hash,
      fixture.source.descriptor.authorization_scope,
      destination,
    );
    expect(new Uint8Array(writeTexture.mock.calls[0][1])).toEqual(expected);
    expect(writeTexture.mock.calls[0][2]).toEqual({
      offset: 0,
      bytesPerRow: 256,
      rowsPerImage: 64,
    });
    const gpu = new MediaGpuRegistry();
    gpu.apply(installed.messages[0]);
    gpu.apply(installed.messages[1], installed.resource, installed.resource.bindGroup);
    const lease = gpu.pin([fixture.frame.hash]);
    expect(lease.bindingForHash(fixture.frame.hash)).toBe(installed.resource.bindGroup);
    expect(() =>
      uploadRasterResource(registry, fixture.message.hash, "other-snapshot", destination),
    ).toThrow(expect.objectContaining({ code: "resource_conflict" }));
    expect(destination.device.createTexture).toHaveBeenCalledOnce();
    lease.release();
    gpu.destroy();
    destroyMediaResource(installed.resource);
    expect(texture.destroy).toHaveBeenCalledOnce();
  },
);
