import { afterEach, describe, expect, it, vi } from "vitest";
import {
  alignedReadbackBytesPerRow,
  compactReadbackRows,
  GpuFrameReadbackPool,
  rawPixelFormat,
} from "./frame-readback";

afterEach(() => vi.unstubAllGlobals());

describe("video export frame readback", () => {
  it("aligns GPU copy rows without padding standard video widths", () => {
    expect(alignedReadbackBytesPerRow(1)).toBe(256);
    expect(alignedReadbackBytesPerRow(1_920)).toBe(7_680);
    expect(alignedReadbackBytesPerRow(3_840)).toBe(15_360);
  });

  it("removes GPU row padding before encoder submission", () => {
    const padded = new Uint8Array(512);
    padded.set([1, 2, 3, 4], 0);
    padded.set([5, 6, 7, 8], 256);
    expect([...new Uint8Array(compactReadbackRows(padded, 1, 2, 256))]).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8,
    ]);
  });

  it("maps only packed 8-bit canvas formats", () => {
    expect(rawPixelFormat("bgra8unorm")).toBe("bgra");
    expect(rawPixelFormat("rgba8unorm-srgb")).toBe("rgba");
    expect(() => rawPixelFormat("rgba16float")).toThrow(/cannot be exported/);
  });

  it("bounds in-flight GPU mappings to three reusable slots", async () => {
    vi.stubGlobal("GPUBufferUsage", { COPY_DST: 1, MAP_READ: 2 });
    vi.stubGlobal("GPUMapMode", { READ: 1 });
    const buffers: Array<{
      bytes: ArrayBuffer;
      mapState: GPUBufferMapState;
      mapAsync: () => Promise<void>;
      getMappedRange: () => ArrayBuffer;
      unmap: () => void;
      destroy: () => void;
    }> = [];
    const device = {
      createBuffer: ({ size }: { size: number }) => {
        const buffer = {
          bytes: new ArrayBuffer(size),
          mapState: "unmapped" as GPUBufferMapState,
          mapAsync: async () => {
            buffer.mapState = "mapped";
          },
          getMappedRange: () => buffer.bytes,
          unmap: () => {
            buffer.mapState = "unmapped";
          },
          destroy: () => undefined,
        };
        buffers.push(buffer);
        return buffer as unknown as GPUBuffer;
      },
    } as unknown as GPUDevice;
    const encoder = { copyTextureToBuffer: vi.fn() } as unknown as GPUCommandEncoder;
    const texture = {} as GPUTexture;
    const pool = new GpuFrameReadbackPool(device, "bgra8unorm", 3);
    const tickets = [pool.reserve(64, 2), pool.reserve(64, 2), pool.reserve(64, 2)];
    expect(() => pool.reserve(64, 2)).toThrow(/busy/);
    tickets[0].encode(encoder, texture);
    await expect(tickets[0].read()).resolves.toMatchObject({ pixelFormat: "bgra" });
    expect(() => pool.reserve(64, 2)).not.toThrow();
    tickets[1].abort();
    tickets[2].abort();
    expect(buffers).toHaveLength(3);
  });
});
