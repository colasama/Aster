import { describe, expect, it } from "vitest";
import { EvaluationCache } from "./evaluation-cache";

describe("evaluation cache", () => {
  it("keys values by revision, time, and resolution", () => {
    const cache = new EvaluationCache<string>(8);
    cache.set({ nodeId: "node", revision: 1, time: 1, width: 1920, height: 1080 }, "frame");
    expect(cache.get({ nodeId: "node", revision: 1, time: 1, width: 1920, height: 1080 })).toBe(
      "frame",
    );
    expect(cache.get({ nodeId: "node", revision: 1, time: 2, width: 1920, height: 1080 })).toBe(
      undefined,
    );
    expect(cache.get({ nodeId: "node", revision: 1, time: 1, width: 960, height: 540 })).toBe(
      undefined,
    );
  });

  it("evicts the least recently used entry", () => {
    const cache = new EvaluationCache<number>(2);
    cache.set({ nodeId: "a", revision: 1 }, 1);
    cache.set({ nodeId: "b", revision: 1 }, 2);
    expect(cache.get({ nodeId: "a", revision: 1 })).toBe(1);
    cache.set({ nodeId: "c", revision: 1 }, 3);
    expect(cache.get({ nodeId: "b", revision: 1 })).toBeUndefined();
    expect(cache.statistics().evictions).toBe(1);
  });

  it("invalidates every cached variant of a dirty node", () => {
    const cache = new EvaluationCache<number>(8);
    cache.set({ nodeId: "dirty", revision: 1, time: 1 }, 1);
    cache.set({ nodeId: "dirty", revision: 1, time: 2 }, 2);
    cache.set({ nodeId: "clean", revision: 1, time: 1 }, 3);
    expect(cache.invalidateNode("dirty")).toBe(2);
    expect(cache.get({ nodeId: "clean", revision: 1, time: 1 })).toBe(3);
    expect(cache.statistics().invalidations).toBe(2);
  });

  it("evicts least-recently-used values to stay inside a byte budget", () => {
    const cache = new EvaluationCache<string>({
      capacity: 8,
      maxBytes: 6,
      sizeOf: (value) => value.length,
    });
    cache.set({ nodeId: "a", revision: 1 }, "aaaa");
    cache.set({ nodeId: "b", revision: 1 }, "bbbb");
    expect(cache.get({ nodeId: "a", revision: 1 })).toBeUndefined();
    expect(cache.get({ nodeId: "b", revision: 1 })).toBe("bbbb");
    expect(cache.statistics()).toMatchObject({ bytes: 4, maxBytes: 6, evictions: 1 });
  });
});
