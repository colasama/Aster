import { describe, expect, it, vi } from "vitest";
import {
  BoundedRenderSessionController,
  ExclusiveRenderSessionGuard,
} from "./render-session-guard";

describe("exclusive production render sessions", () => {
  it("rejects concurrent sessions and restores exactly once", () => {
    const guard = new ExclusiveRenderSessionGuard();
    const restore = vi.fn();
    const lease = guard.acquire(restore);

    expect(() => guard.acquire(() => undefined)).toThrow("already active");
    lease.close();
    lease.close();

    expect(restore).toHaveBeenCalledOnce();
    expect(guard.active).toBe(false);
  });

  it("releases the renderer when restoration fails", () => {
    const guard = new ExclusiveRenderSessionGuard();
    const lease = guard.acquire(() => {
      throw new Error("restore failed");
    });

    expect(() => lease.close()).toThrow("restore failed");
    expect(guard.active).toBe(false);
    expect(() => guard.acquire(() => undefined)).not.toThrow();
  });
});

describe("bounded production frame work", () => {
  it("defers restoration until an accepted frame settles", async () => {
    const restore = vi.fn();
    let finish: ((value: number) => void) | undefined;
    const frame = new Promise<number>((resolve) => {
      finish = resolve;
    });
    const session = new BoundedRenderSessionController({ close: restore }, 1);
    const rendered = session.run(() => frame);

    session.close();
    expect(restore).not.toHaveBeenCalled();
    finish?.(42);

    await expect(rendered).resolves.toBe(42);
    expect(restore).toHaveBeenCalledOnce();
    await expect(session.run(async () => 0)).rejects.toThrow("already closed");
  });

  it("rejects work beyond the declared frame concurrency", async () => {
    let finish: (() => void) | undefined;
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const session = new BoundedRenderSessionController({ close: () => undefined }, 1);
    const first = session.run(() => pending);

    await expect(session.run(async () => undefined)).rejects.toThrow("bounded in-flight");
    finish?.();
    await first;
  });
});
