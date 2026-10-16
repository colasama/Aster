import { afterEach, expect, it, vi } from "vitest";
import { readRetainedMediaPixels } from "./media-pixel-readback";

afterEach(() => vi.unstubAllGlobals());
function setup(capacity: number, failMap = 0) {
  vi.stubGlobal("GPUBufferUsage", { COPY_DST: 1, MAP_READ: 2 });
  vi.stubGlobal("GPUMapMode", { READ: 1 });
  const buffers: {
    bytes: Uint8Array;
    destroy: ReturnType<typeof vi.fn>;
    unmap: ReturnType<typeof vi.fn>;
  }[] = [];
  const device = {
    limits: { maxBufferSize: capacity },
    createBuffer: ({ size }: GPUBufferDescriptor) => {
      const index = buffers.length + 1;
      const buffer = {
        bytes: new Uint8Array(size),
        mapState: "mapped",
        mapAsync: async () => {
          if (index === failMap) throw Error("device lost");
        },
        getMappedRange() {
          return this.bytes.buffer;
        },
        destroy: vi.fn(),
        unmap: vi.fn(),
      };
      buffers.push(buffer);
      return buffer;
    },
    queue: {
      submit: vi.fn((commands: (() => void)[]) => {
        for (const command of commands) command();
      }),
    },
    createCommandEncoder: () => {
      const copies: (() => void)[] = [];
      return {
        copyTextureToBuffer: (
          source: { texture: GPUTexture & { seed: number }; origin: number[] },
          destination: { buffer: { bytes: Uint8Array }; offset: number; bytesPerRow: number },
          size: number[],
        ) => {
          copies.push(() => {
            for (let y = 0; y < size[1]; y++)
              for (let x = 0; x < size[0] * 4; x++)
                destination.buffer.bytes[destination.offset + y * destination.bytesPerRow + x] =
                  source.texture.seed + (source.origin[1] + y) * 10 + x;
          });
        },
        finish: () => () => {
          for (const copy of copies) copy();
        },
      };
    },
  };
  const textures = [
    { width: 3, height: 3, seed: 1 },
    { width: 5, height: 1, seed: 80 },
  ] as unknown as GPUTexture[];
  return { device: device as unknown as GPUDevice, buffers, textures };
}

it.each([512, 1024])(
  "packs mixed dimensions and splits rows without changing bytes at capacity %s",
  async (capacity) => {
    const f = setup(capacity);
    const result = await readRetainedMediaPixels(f.device, f.textures);
    expect(result[0]).toEqual(
      Uint8Array.from({ length: 36 }, (_, i) => 1 + Math.floor(i / 12) * 10 + (i % 12)),
    );
    expect(result[1]).toEqual(Uint8Array.from({ length: 20 }, (_, i) => 80 + i));
    expect(f.buffers).toHaveLength(1024 / capacity);
    expect(f.device.queue.submit).toHaveBeenCalledTimes(1024 / capacity);
    for (const buffer of f.buffers) {
      expect(buffer.bytes.length).toBeLessThanOrEqual(capacity);
      expect(buffer.destroy).toHaveBeenCalledOnce();
      expect(buffer.unmap).toHaveBeenCalledOnce();
    }
  },
);

it("destroys successful and failed batches when a later mapping fails", async () => {
  const f = setup(512, 2);
  await expect(readRetainedMediaPixels(f.device, f.textures)).rejects.toThrow("device lost");
  expect(f.buffers).toHaveLength(2);
  for (const buffer of f.buffers) expect(buffer.destroy).toHaveBeenCalledOnce();
});
