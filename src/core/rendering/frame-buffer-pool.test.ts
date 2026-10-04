import { describe, expect, it } from "vitest";
import { FrameBufferPool } from "./frame-buffer-pool";

describe("owned CPU frame buffer leases", () => {
  it("bounds live destinations and only reuses a released buffer", () => {
    const pool = new FrameBufferPool(16, 2);
    const first = pool.acquire();
    const second = pool.acquire();
    const firstBuffer = first.buffer;
    const secondBuffer = second.buffer;
    new Uint8Array(firstBuffer).fill(17);
    new Uint8Array(secondBuffer).fill(29);
    expect(firstBuffer).not.toBe(secondBuffer);
    expect(() => pool.acquire()).toThrow("leased");

    first.release();
    const next = pool.acquire();
    expect(next.buffer).toBe(firstBuffer);
    new Uint8Array(next.buffer).fill(41);
    expect([...new Uint8Array(secondBuffer)]).toEqual(new Array(16).fill(29));
    first.release();
    expect(() => pool.acquire()).toThrow("leased");
    expect(() => first.buffer).toThrow("released");
    next.release();
    second.release();
  });

  it("keeps pools independent and allocates fixed ordinary ArrayBuffers", () => {
    const first = new FrameBufferPool(12, 1).acquire();
    const second = new FrameBufferPool(12, 1).acquire();
    expect(first.buffer).toBeInstanceOf(ArrayBuffer);
    expect(first.buffer).not.toBe(second.buffer);
    expect(first.buffer.byteLength).toBe(12);
    first.release();
    expect(second.buffer.byteLength).toBe(12);
    second.release();
  });

  it("fails closed if a consumer detaches a leased destination", () => {
    const pool = new FrameBufferPool(8, 1);
    const lease = pool.acquire();
    const buffer = lease.buffer;
    structuredClone(buffer, { transfer: [buffer] });
    expect(() => lease.buffer).toThrow("detached");
    expect(() => lease.release()).toThrow("detached");
    expect(() => lease.release()).not.toThrow();
    expect(() => pool.acquire()).toThrow("detached");
  });

  it.each([
    [0, 1],
    [8, 0],
    [1.5, 2],
    [8, Number.NaN],
    [8, 1.5],
    [Number.MAX_SAFE_INTEGER, 2],
  ])("rejects an invalid extent or capacity (%s, %s)", (bytes, capacity) => {
    expect(() => new FrameBufferPool(bytes, capacity)).toThrow("bounded");
  });
});
