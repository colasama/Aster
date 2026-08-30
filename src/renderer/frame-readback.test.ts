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

  it("returns one packed 4K frame from a production-aligned mapped range", () => {
    const width = 3_840;
    const height = 2_160;
    const bytesPerRow = alignedReadbackBytesPerRow(width);
    const mapped = new Uint8Array(bytesPerRow * height);
    mapped.set([17, 34, 51, 255], 0);
    mapped.set([68, 85, 102, 255], mapped.byteLength - 4);

    const packed = new Uint8Array(compactReadbackRows(mapped, width, height, bytesPerRow));

    expect(bytesPerRow).toBe(width * 4);
    expect(packed.byteLength).toBe(width * height * 4);
    expect([...packed.subarray(0, 4)]).toEqual([17, 34, 51, 255]);
    expect([...packed.subarray(-4)]).toEqual([68, 85, 102, 255]);
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

  it("aborts active tickets and destroys buffers idempotently", () => {
    vi.stubGlobal("GPUBufferUsage", { COPY_DST: 1, MAP_READ: 2 });
    const destroy = vi.fn();
    const device = {
      createBuffer: ({ size }: { size: number }) =>
        ({
          mapState: "unmapped",
          mapAsync: vi.fn(),
          getMappedRange: () => new ArrayBuffer(size),
          unmap: vi.fn(),
          destroy,
        }) as unknown as GPUBuffer,
    } as unknown as GPUDevice;
    const pool = new GpuFrameReadbackPool(device, "rgba8unorm", 2);
    const ticket = pool.reserve(8, 8);

    pool.destroy();
    pool.destroy();

    expect(destroy).toHaveBeenCalledTimes(2);
    expect(() => ticket.encode({} as GPUCommandEncoder, {} as GPUTexture)).toThrow(
      "no longer writable",
    );
    expect(() => pool.reserve(8, 8)).toThrow("destroyed");
  });
});
