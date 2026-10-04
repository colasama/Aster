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

  it("copies every tight-row byte into the caller's destination without borrowing mapped memory", () => {
    const backing = new Uint8Array(24).fill(99);
    const mapped = backing.subarray(4, 20);
    mapped.set(Array.from({ length: 16 }, (_, index) => index + 1));
    const destination = new ArrayBuffer(16);
    expect(compactReadbackRows(mapped, 2, 2, 8, destination)).toBe(destination);
    expect([...new Uint8Array(destination)]).toEqual(
      Array.from({ length: 16 }, (_, index) => index + 1),
    );
    mapped.fill(0);
    structuredClone(backing.buffer, { transfer: [backing.buffer] });
    expect([...new Uint8Array(destination)]).toEqual(
      Array.from({ length: 16 }, (_, index) => index + 1),
    );
  });

  it("reuses a destination across padded frames and preserves the default independently owned output", () => {
    const backing = new Uint8Array(530).fill(222);
    const mapped = backing.subarray(17, 529);
    const destination = new ArrayBuffer(8);
    for (const offset of [0, 20]) {
      mapped.set([1 + offset, 2 + offset, 3 + offset, 4 + offset], 0);
      mapped.set([5 + offset, 6 + offset, 7 + offset, 8 + offset], 256);
      const expected = Array.from({ length: 8 }, (_, index) => index + 1 + offset);
      expect(compactReadbackRows(mapped, 1, 2, 256, destination)).toBe(destination);
      expect([...new Uint8Array(destination)]).toEqual(expected);
      const owned = compactReadbackRows(mapped, 1, 2, 256);
      new Uint8Array(destination).fill(0);
      expect([...new Uint8Array(owned)]).toEqual(expected);
    }
    const first = compactReadbackRows(mapped, 64, 2, 256);
    const second = compactReadbackRows(mapped, 64, 2, 256);
    new Uint8Array(first).fill(0);
    expect(new Uint8Array(second)[0]).toBe(21);
  });

  it("rejects destination size, lifetime and alias violations before copying", () => {
    const source = new Uint8Array(16).fill(7);
    const detached = new ArrayBuffer(16);
    structuredClone(detached, { transfer: [detached] });
    const resizable = Reflect.construct(ArrayBuffer, [16, { maxByteLength: 32 }]) as ArrayBuffer;
    const invalid = [
      new ArrayBuffer(15),
      new ArrayBuffer(17),
      detached,
      resizable,
      new SharedArrayBuffer(16) as unknown as ArrayBuffer,
      null as unknown as ArrayBuffer,
    ];
    for (const destination of invalid)
      expect(() => compactReadbackRows(source, 2, 2, 8, destination)).toThrow(/destination/);
    expect(() => compactReadbackRows(source, 2, 2, 8, source.buffer)).toThrow(/alias/);
    expect([...source]).toEqual(Array(16).fill(7));
  });

  it("rechecks a destination detached during mapping and releases the GPU slot on failure", async () => {
    vi.stubGlobal("GPUBufferUsage", { COPY_DST: 1, MAP_READ: 2 });
    vi.stubGlobal("GPUMapMode", { READ: 1 });
    let finishMap: (() => void) | undefined;
    const buffer = {
      mapState: "unmapped" as GPUBufferMapState,
      mapAsync: () =>
        new Promise<void>((resolve) => {
          finishMap = () => {
            buffer.mapState = "mapped";
            resolve();
          };
        }),
      getMappedRange: () => new ArrayBuffer(256),
      unmap: vi.fn(() => {
        buffer.mapState = "unmapped";
      }),
      destroy: vi.fn(),
    };
    const device = { createBuffer: () => buffer } as unknown as GPUDevice;
    const pool = new GpuFrameReadbackPool(device, "rgba8unorm", 1);
    const ticket = pool.reserve(64, 1);
    ticket.encode(
      { copyTextureToBuffer: vi.fn() } as unknown as GPUCommandEncoder,
      {} as GPUTexture,
    );
    const destination = new ArrayBuffer(256);
    const pending = ticket.read(destination);
    structuredClone(destination, { transfer: [destination] });
    expect(finishMap).toBeDefined();
    finishMap?.();
    await expect(pending).rejects.toThrow(/destination/);
    expect(buffer.unmap).toHaveBeenCalledOnce();
    expect(pool.reset()).toBe(true);
    expect(buffer.destroy).toHaveBeenCalledOnce();
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
