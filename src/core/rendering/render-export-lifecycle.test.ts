// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import { FrameBufferPool } from "./frame-buffer-pool";
import { streamFramePipeline } from "./render-export";

function signal<T>() {
  let resolve = (_value: T) => {};
  let reject = (_reason: unknown) => {};
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

describe("frame pipeline output ownership", () => {
  it("retains the writing frame until acknowledgment and reuses a bounded window", async () => {
    const pool = new FrameBufferPool(8, 4);
    const writing = signal<void>();
    const acknowledge = signal<void>();
    const destinations = new Set<ArrayBuffer>();
    const released: number[] = [];
    const written: number[] = [];
    let rendered = 0;
    const result = streamFramePipeline({
      frameCount: 9,
      maxInFlight: 3,
      cancelled: () => false,
      render: async (index) => {
        const lease = pool.acquire();
        destinations.add(lease.buffer);
        new Uint8Array(lease.buffer).fill(index);
        rendered++;
        return { index, lease };
      },
      write: async (frame) => {
        if (frame.index === 0) {
          writing.resolve();
          await acknowledge.promise;
        }
        expect([...new Uint8Array(frame.lease.buffer)]).toEqual(new Array(8).fill(frame.index));
        written.push(frame.index);
      },
      release: (frame) => {
        frame.lease.release();
        released.push(frame.index);
      },
      onProgress: () => undefined,
    });
    await writing.promise;
    expect(rendered).toBe(4);
    expect(released).toEqual([]);
    acknowledge.resolve();
    expect(await result).toBe(9);
    expect(written).toEqual(Array.from({ length: 9 }, (_, index) => index));
    expect(released).toEqual(written);
    expect(destinations.size).toBe(4);
  });

  it("releases a selected frame when cancellation arrives during its readback", async () => {
    const first = signal<number>();
    const submitted = signal<void>();
    const release = vi.fn();
    const write = vi.fn();
    let cancelled = false;
    const result = streamFramePipeline({
      frameCount: 5,
      maxInFlight: 3,
      cancelled: () => cancelled,
      render: (index) => {
        if (index === 2) submitted.resolve();
        return index === 0 ? first.promise : Promise.resolve(index);
      },
      release,
      write,
      onProgress: () => undefined,
    });
    await submitted.promise;
    cancelled = true;
    first.resolve(0);
    expect(await result).toBe(0);
    expect(write).not.toHaveBeenCalled();
    expect(release.mock.calls.flat().sort()).toEqual([0, 1, 2]);
  });

  it("drains each successful lookahead on write failure without waiting for all others", async () => {
    const delayed = signal<number>();
    const release = vi.fn();
    const failure = new Error("encoder rejected the frame");
    const result = streamFramePipeline({
      frameCount: 4,
      maxInFlight: 3,
      cancelled: () => false,
      render: (index) => (index === 2 ? delayed.promise : Promise.resolve(index)),
      write: async () => {
        throw failure;
      },
      release,
      onProgress: () => undefined,
    });
    const rejected = expect(result).rejects.toBe(failure);
    await vi.waitFor(() => expect(release.mock.calls.flat().sort()).toEqual([0, 1, 3]));
    delayed.resolve(2);
    await rejected;
    expect(release.mock.calls.flat().sort()).toEqual([0, 1, 2, 3]);
  });

  it("preserves render rejection and releases fulfilled sibling frames", async () => {
    const failure = new Error("render failed");
    const release = vi.fn();
    await expect(
      streamFramePipeline({
        frameCount: 3,
        maxInFlight: 3,
        cancelled: () => false,
        render: (index) => (index === 0 ? Promise.reject(failure) : Promise.resolve(index)),
        write: vi.fn(),
        release,
        onProgress: () => undefined,
      }),
    ).rejects.toBe(failure);
    expect(release.mock.calls.flat().sort()).toEqual([1, 2]);
  });

  it("releases current and pending frames when a pause/control boundary rejects", async () => {
    const release = vi.fn();
    const failure = new Error("control failed");
    let boundaries = 0;
    await expect(
      streamFramePipeline({
        frameCount: 3,
        maxInFlight: 3,
        cancelled: () => false,
        render: async (index) => index,
        beforeFrame: async () => {
          if (++boundaries === 2) throw failure;
        },
        write: vi.fn(),
        release,
        onProgress: () => undefined,
      }),
    ).rejects.toBe(failure);
    expect(release.mock.calls.flat().sort()).toEqual([0, 1, 2]);
  });

  it("preserves a write error when releasing that frame also fails", async () => {
    const primary = new Error("write rejected");
    const release = vi.fn(() => {
      throw new Error("destination detached");
    });
    await expect(
      streamFramePipeline({
        frameCount: 3,
        maxInFlight: 3,
        cancelled: () => false,
        render: async (index) => index,
        write: async () => {
          throw primary;
        },
        release,
        onProgress: () => undefined,
      }),
    ).rejects.toBe(primary);
    expect(release.mock.calls).toHaveLength(3);
  });

  it("does not report clean cancellation when discarded-frame cleanup fails", async () => {
    let cancelled = false;
    const cleanupFailure = new Error("discarded destination detached");
    const release = vi.fn((index: number) => {
      if (index === 1) throw cleanupFailure;
    });
    await expect(
      streamFramePipeline({
        frameCount: 3,
        maxInFlight: 3,
        cancelled: () => cancelled,
        render: async (index) => index,
        write: async () => {
          cancelled = true;
        },
        release,
        onProgress: () => undefined,
      }),
    ).rejects.toBe(cleanupFailure);
    expect(release.mock.calls.flat().sort()).toEqual([0, 1, 2]);
  });
});
