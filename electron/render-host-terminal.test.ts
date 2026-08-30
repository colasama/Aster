import { describe, expect, it, vi } from "vitest";
import { settleRenderHostTerminal } from "./render-host-terminal";

describe("RenderHost terminal settlement", () => {
  it("publishes the terminal state before waiting for external cleanup", async () => {
    const cleanup = deferred<void>();
    const events: string[] = [];
    const settlement = settleRenderHostTerminal(
      async () => {
        events.push("reported");
      },
      async () => {
        events.push("cleanup-started");
        await cleanup.promise;
        events.push("cleanup-finished");
      },
    );

    await vi.waitFor(() => expect(events).toEqual(["reported", "cleanup-started"]));
    cleanup.resolve(undefined);
    await settlement;
    expect(events).toEqual(["reported", "cleanup-started", "cleanup-finished"]);
  });

  it("still disposes the worker when the terminal report is rejected", async () => {
    const dispose = vi.fn(async () => undefined);
    await expect(
      settleRenderHostTerminal(async () => {
        throw new Error("stale lease");
      }, dispose),
    ).rejects.toThrow("stale lease");
    expect(dispose).toHaveBeenCalledOnce();
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
