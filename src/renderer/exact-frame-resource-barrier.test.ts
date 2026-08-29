import { describe, expect, it, vi } from "vitest";
import { captureAfterExactFrameResources } from "./exact-frame-resource-barrier";
import { releaseFailedWebGpuInitialization, shouldReportGpuDeviceLoss } from "./webgpu-renderer";

describe("exact-frame resource capture", () => {
  it("suppresses intentional device loss after renderer disposal only", () => {
    expect(shouldReportGpuDeviceLoss(true)).toBe(false);
    expect(shouldReportGpuDeviceLoss(false)).toBe(true);
    expect(shouldReportGpuDeviceLoss(false, true)).toBe(false);
  });

  it("releases a failed WebGPU initialization without destroying the device twice", () => {
    const device = { destroy: vi.fn() };
    const renderer = { dispose: vi.fn() };

    releaseFailedWebGpuInitialization(renderer, device);
    expect(renderer.dispose).toHaveBeenCalledOnce();
    expect(device.destroy).not.toHaveBeenCalled();

    releaseFailedWebGpuInitialization(undefined, device);
    expect(device.destroy).toHaveBeenCalledOnce();

    const failingRenderer = {
      dispose: vi.fn(() => {
        throw new Error("dispose failed");
      }),
    };
    expect(() => releaseFailedWebGpuInitialization(failingRenderer, device)).toThrow(
      "dispose failed",
    );
    expect(device.destroy).toHaveBeenCalledTimes(2);
  });

  it("keeps cached frames on one capture after the resource error barrier", async () => {
    const events: string[] = [];
    const capture = vi.fn(async () => {
      events.push("capture");
      return "cached";
    });
    const result = await captureAfterExactFrameResources(capture, {
      hasPendingFrameResources: false,
      waitForFrameResources: async () => {
        events.push("barrier");
      },
    });

    expect(result).toBe("cached");
    expect(capture).toHaveBeenCalledTimes(1);
    expect(events).toEqual(["capture", "barrier"]);
  });

  it("recaptures only after a newly discovered media generation becomes ready", async () => {
    const gate = deferred<void>();
    const frames: string[] = [];
    const capture = vi.fn(async () => {
      const frame = frames.length === 0 ? "placeholder" : "exact";
      frames.push(frame);
      return frame;
    });
    const result = captureAfterExactFrameResources(capture, {
      hasPendingFrameResources: true,
      waitForFrameResources: () => gate.promise,
    });

    await Promise.resolve();
    expect(frames).toEqual(["placeholder"]);
    gate.resolve(undefined);
    await expect(result).resolves.toBe("exact");
    expect(frames).toEqual(["placeholder", "exact"]);
  });

  it("drains an accepted capture before propagating a media barrier failure", async () => {
    const captureGate = deferred<string>();
    const rejected = captureAfterExactFrameResources(() => captureGate.promise, {
      hasPendingFrameResources: true,
      waitForFrameResources: async () => {
        throw new Error("image decode failed");
      },
    });
    let settled = false;
    void rejected.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );

    await Promise.resolve();
    expect(settled).toBe(false);
    captureGate.resolve("placeholder");
    await expect(rejected).rejects.toThrow("image decode failed");
  });
});

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}
