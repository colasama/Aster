import { describe, expect, it, vi } from "vitest";
import {
  compositionFrameIndex,
  compositionFrameTime,
  isFrameCacheBudget,
  normalizeFrameCacheBudget,
} from "./frame-cache-policy";
import {
  type CachedPreviewFrame,
  cachedFrameRanges,
  PreviewFrameCache,
} from "./preview-frame-cache";

const MIB = 1024 * 1024;

function frame(megabytes = 1): CachedPreviewFrame {
  return { pixels: new ArrayBuffer(megabytes * MIB), width: 512, height: 512, pixelFormat: "bgra" };
}

function immediateCache(budgetMb: number) {
  const notify = vi.fn();
  const cache = new PreviewFrameCache(budgetMb, (deliver) => deliver());
  cache.subscribe(notify);
  return { cache, notify };
}

describe("preview frame cache", () => {
  it("replays stored frames and evicts the least recently used past its budget", () => {
    const { cache } = immediateCache(3);
    cache.activate("comp", "v1");
    for (const index of [0, 1, 2]) expect(cache.store("comp", "v1", index, frame())).toBe(true);
    expect(cache.lookup("comp", "v1", 0)).toBeDefined();
    cache.store("comp", "v1", 3, frame());
    expect(cache.cachedFrames("comp")).toEqual([0, 2, 3]);
    expect(cache.usage()).toEqual({ usedBytes: 3 * MIB, budgetBytes: 3 * MIB, frameCount: 3 });
  });

  it("drops a composition's frames when its scope changes and rejects stale captures", () => {
    const { cache } = immediateCache(8);
    cache.activate("comp", "v1");
    cache.activate("other", "o1");
    cache.store("comp", "v1", 0, frame());
    cache.store("other", "o1", 5, frame());
    expect(cache.lookup("comp", "v2", 0)).toBeUndefined();
    expect(cache.cachedFrames("comp")).toEqual([]);
    expect(cache.cachedFrames("other")).toEqual([5]);
    // A readback that finishes after the edit must not resurrect the old version.
    expect(cache.store("comp", "v1", 1, frame())).toBe(false);
    expect(cache.store("comp", "v2", 1, frame())).toBe(true);
  });

  it("disables itself at a zero budget and ignores frames larger than the budget", () => {
    const { cache } = immediateCache(2);
    cache.activate("comp", "v1");
    expect(cache.store("comp", "v1", 0, frame(3))).toBe(false);
    cache.store("comp", "v1", 0, frame());
    cache.setBudgetMb(0);
    expect(cache.enabled).toBe(false);
    expect(cache.usage().frameCount).toBe(0);
    expect(cache.store("comp", "v1", 0, frame())).toBe(false);
  });

  it("coalesces change notifications for the timeline", () => {
    const deliveries: Array<() => void> = [];
    const cache = new PreviewFrameCache(8, (deliver) => deliveries.push(deliver));
    const listener = vi.fn();
    cache.subscribe(listener);
    cache.activate("comp", "v1");
    cache.store("comp", "v1", 0, frame());
    cache.store("comp", "v1", 1, frame());
    expect(deliveries).toHaveLength(1);
    deliveries[0]();
    expect(listener).toHaveBeenCalledOnce();
    cache.clear();
    expect(deliveries).toHaveLength(2);
  });

  it("collapses frames into contiguous timeline ranges", () => {
    expect(cachedFrameRanges([0, 1, 2, 5, 6, 9])).toEqual([
      { start: 0, count: 3 },
      { start: 5, count: 2 },
      { start: 9, count: 1 },
    ]);
  });

  it("quantizes rational frame rates without boundary drift", () => {
    const ntsc = { numerator: 30_000, denominator: 1_001 };
    expect(compositionFrameIndex(compositionFrameTime(299, ntsc), ntsc)).toBe(299);
    expect(compositionFrameIndex(0.0333, { numerator: 30, denominator: 1 })).toBe(0);
    expect(normalizeFrameCacheBudget(-1)).toBe(2_048);
    expect(isFrameCacheBudget(0)).toBe(true);
    expect(isFrameCacheBudget(1.5)).toBe(false);
  });
});
