import { describe, expect, it, vi } from "vitest";
import {
  type CachedPreviewFrame,
  PreviewFrameCache,
} from "../../core/rendering/preview-frame-cache";
import type { RendererMetrics } from "../../core/types";
import {
  type PrerenderJob,
  type PrerenderRenderer,
  PreviewPrerenderer,
  prerenderFrameOrder,
} from "./preview-prerenderer";

const MIB = 1024 * 1024;

function pixels(): CachedPreviewFrame {
  return { pixels: new ArrayBuffer(MIB), width: 512, height: 512, pixelFormat: "bgra" };
}

/** Renders synchronously; `outcome(frame)` decides whether the capture succeeds or media holds. */
function setup(budgetMb: number, outcome: (frame: number) => "ok" | "held" | "incomplete") {
  const cache = new PreviewFrameCache(budgetMb, () => undefined);
  let capture: ((frame?: CachedPreviewFrame) => void) | undefined;
  const events: string[] = [];
  const renderer: PrerenderRenderer = {
    capturePreviewFrame: (onFrame) => {
      capture = onFrame;
    },
    presentCachedFrame: () => {
      events.push("restore");
      return true;
    },
    waitForPreviewResources: vi.fn(async () => {
      events.push("wait");
    }),
  };
  const attempts = new Map<number, number>();
  const render = (frame: number): RendererMetrics => {
    events.push(`render ${frame}`);
    const tries = (attempts.get(frame) ?? 0) + 1;
    attempts.set(frame, tries);
    const result = outcome(frame);
    const held = result === "held" && tries === 1;
    capture?.(result === "ok" || (result === "held" && !held) ? pixels() : undefined);
    capture = undefined;
    return { mediaPending: held } as RendererMetrics;
  };
  const prerenderer = new PreviewPrerenderer({ cache, renderer, idle: async () => undefined });
  cache.activate("comp", "v1");
  const job = (frames: number[]): PrerenderJob => ({
    compositionId: "comp",
    scope: "v1",
    displayed: pixels(),
    frames,
    render,
  });
  return { cache, events, prerenderer, job, renderer };
}

describe("preview prerenderer", () => {
  it("orders frames forward from the playhead, then wraps to the work-area start", () => {
    expect(prerenderFrameOrder(3, 0, 6)).toEqual([4, 5, 6, 0, 1, 2]);
    expect(prerenderFrameOrder(10, 2, 5)).toEqual([2, 3, 4, 5]);
  });

  it("fills the cache and restores the displayed frame after every background render", async () => {
    const { cache, events, prerenderer, job } = setup(16, () => "ok");
    cache.store("comp", "v1", 2, pixels());
    await prerenderer.start(job([1, 2, 3]));
    expect(cache.cachedFrames("comp")).toEqual([1, 2, 3]);
    expect(events).toEqual(["render 1", "restore", "render 3", "restore"]);
  });

  it("retries a frame held for loading media and skips other incomplete frames", async () => {
    const { cache, events, prerenderer, job } = setup(16, (frame) =>
      frame === 1 ? "held" : frame === 2 ? "incomplete" : "ok",
    );
    await prerenderer.start(job([1, 2, 3]));
    expect(cache.cachedFrames("comp")).toEqual([1, 3]);
    expect(events.filter((event) => event === "render 1")).toHaveLength(2);
    expect(events).toContain("wait");
    expect(events.filter((event) => event === "render 2")).toHaveLength(1);
  });

  it("keeps its own window newest so wrapping never evicts frames ahead of the playhead", async () => {
    const { cache, prerenderer, job } = setup(5, () => "ok");
    // A full cache whose oldest entries, 3 and 4, are inside the job's window and 0 is not.
    for (const frame of [3, 4, 0, 7, 8]) cache.store("comp", "v1", frame, pixels());
    await prerenderer.start(job([3, 4, 5]));
    expect(cache.cachedFrames("comp")).toEqual([3, 4, 5, 7, 8]);
  });

  it("stops at the frames that fit the budget and when a newer job starts", async () => {
    const budget = setup(5, () => "ok");
    await budget.prerenderer.start(budget.job([0, 1, 2, 3, 4, 5]));
    expect(budget.cache.cachedFrames("comp")).toEqual([0, 1, 2]);

    const cancelled = setup(16, () => "ok");
    const first = cancelled.prerenderer.start(cancelled.job([0, 1, 2]));
    cancelled.prerenderer.stop();
    await first;
    expect(cancelled.cache.cachedFrames("comp")).toEqual([]);
  });
});
