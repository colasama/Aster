import {
  compositionFrameIndex,
  compositionFrameTime,
} from "../../core/rendering/frame-cache-policy";
import type {
  CachedPreviewFrame,
  PreviewFrameCache,
} from "../../core/rendering/preview-frame-cache";
import type { RendererMetrics } from "../../core/types";
import type { BeautyFrameRequest } from "../compositing/beauty-frame";
import { previewFrameScope } from "./preview-frame-scope";

export interface CachingRenderer {
  presentCachedFrame(frame: CachedPreviewFrame): boolean;
  /** `onFrame` settles once per armed render: the pixels, or undefined when not captured. */
  capturePreviewFrame(onFrame: (frame?: CachedPreviewFrame) => void): void;
}

export interface PreviewFramePlan {
  compositionId: string;
  scope: string;
  frame: number;
  /** Start time of `frame`; cached frames always render here. */
  frameTime: number;
  /** Whether the request time lies on the frame boundary. */
  onFrame: boolean;
}

/** Where a beauty request lives in the preview cache. */
export function previewFramePlan(request: BeautyFrameRequest): PreviewFramePlan {
  const frameRate = request.composition.frameRate;
  const frame = compositionFrameIndex(request.time, frameRate);
  const frameTime = compositionFrameTime(frame, frameRate);
  return {
    compositionId: request.composition.id,
    scope: previewFrameScope({
      project: request.project,
      composition: request.composition,
      width: request.target.width,
      height: request.target.height,
      antiAliasing: request.antiAliasing,
    }),
    frame,
    frameTime,
    onFrame: Math.abs(frameTime - request.time) < 1e-6,
  };
}

/**
 * Presents a beauty frame from the preview cache when possible, otherwise renders it and arms a
 * capture so the finished frame fills the cache. Cached playback snaps to composition frames, as
 * export does; a paused off-frame time renders exactly and is never cached.
 *
 * Returns undefined when a cached frame was presented without rendering.
 */
export function presentWithPreviewCache(options: {
  cache: PreviewFrameCache;
  renderer: CachingRenderer;
  request: BeautyFrameRequest;
  playing: boolean;
  present(request: BeautyFrameRequest): RendererMetrics;
}): RendererMetrics | undefined {
  const { cache, renderer, request } = options;
  if (!cache.enabled) return options.present(request);
  const plan = previewFramePlan(request);
  if (plan.frame < 0 || (!options.playing && !plan.onFrame)) return options.present(request);
  const cached = cache.lookup(plan.compositionId, plan.scope, plan.frame);
  if (cached && renderer.presentCachedFrame(cached)) return undefined;
  renderer.capturePreviewFrame((captured) => {
    if (captured) cache.store(plan.compositionId, plan.scope, plan.frame, captured);
  });
  return options.present({ ...request, time: plan.frameTime });
}
