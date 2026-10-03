import type {
  CachedPreviewFrame,
  PreviewFrameCache,
} from "../../core/rendering/preview-frame-cache";
import type { RendererMetrics } from "../../core/types";
import type { CachingRenderer } from "./cached-beauty-presenter";

/** Attempts per frame that waits for loading media before the frame is skipped. */
const MEDIA_ATTEMPTS = 3;

export interface PrerenderRenderer extends CachingRenderer {
  waitForPreviewResources(): Promise<void>;
}

export interface PrerenderJob {
  compositionId: string;
  scope: string;
  /** The frame on screen; restored after every background render so the canvas never changes. */
  displayed: CachedPreviewFrame;
  /** Frames to fill, nearest first. */
  frames: readonly number[];
  /** Renders `frame` through the production beauty pipeline. */
  render(frame: number): RendererMetrics;
}

export interface PrerenderHost {
  cache: PreviewFrameCache;
  renderer: PrerenderRenderer;
  /** Resolves when the editor is idle enough for one background frame. */
  idle(): Promise<void>;
}

/**
 * Fills the preview cache ahead of a paused playhead, one frame per idle slot. Each frame renders
 * through the ordinary pipeline with a capture armed, then the displayed frame is written back in
 * the same task, so only the cache and the timeline observe the work. Starting a job cancels the
 * previous one; the job stops once the frames that fit the cache budget are filled.
 */
export class PreviewPrerenderer {
  readonly #host: PrerenderHost;
  #generation = 0;

  constructor(host: PrerenderHost) {
    this.#host = host;
  }

  start(job: PrerenderJob): Promise<void> {
    const generation = ++this.#generation;
    return this.#run(job, () => generation !== this.#generation).catch(() => undefined);
  }

  stop(): void {
    this.#generation += 1;
  }

  async #run(job: PrerenderJob, cancelled: () => boolean): Promise<void> {
    const { cache, renderer } = this.#host;
    const frameBytes = Math.max(1, job.displayed.pixels.byteLength);
    // The job's window fits the budget with room for the displayed frame and one in flight. Frames
    // already cached are touched as the job passes them, so the whole window stays newest and
    // eviction only ever removes frames outside it.
    let remaining = Math.floor(cache.usage().budgetBytes / frameBytes) - 2;
    for (const frame of job.frames) {
      if (remaining <= 0) return;
      if (cache.lookup(job.compositionId, job.scope, frame)) {
        remaining -= 1;
        continue;
      }
      for (let attempt = 0; attempt < MEDIA_ATTEMPTS; attempt += 1) {
        await this.#host.idle();
        if (cancelled()) return;
        let metrics: RendererMetrics | undefined;
        const captured = new Promise<CachedPreviewFrame | undefined>((resolve) =>
          renderer.capturePreviewFrame(resolve),
        );
        try {
          metrics = job.render(frame);
        } finally {
          renderer.presentCachedFrame(job.displayed);
        }
        const pixels = await captured;
        if (cancelled()) return;
        if (pixels) {
          if (!cache.store(job.compositionId, job.scope, frame, pixels)) return;
          remaining -= 1;
          break;
        }
        // A frame held for loading media is retried once it is ready; any other incomplete frame
        // (a missing plugin, an unsettled resource) is left for live preview to render.
        if (!metrics?.mediaPending) break;
        await renderer.waitForPreviewResources().catch(() => undefined);
      }
    }
  }
}

/** Frames from just after the playhead to the work-area end, then from its start to the playhead. */
export function prerenderFrameOrder(current: number, first: number, last: number): number[] {
  const frames: number[] = [];
  for (let frame = Math.max(first, current + 1); frame <= last; frame += 1) frames.push(frame);
  for (let frame = first; frame < Math.min(current, last + 1); frame += 1) frames.push(frame);
  return frames;
}

export function idleSlot(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof requestIdleCallback === "function")
      requestIdleCallback(() => resolve(), { timeout: 100 });
    else setTimeout(resolve, 0);
  });
}
