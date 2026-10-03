import { describe, expect, it, vi } from "vitest";
import { activeComposition, createDemoProject } from "../../core/project/project";
import {
  type CachedPreviewFrame,
  PreviewFrameCache,
} from "../../core/rendering/preview-frame-cache";
import type { Project, RendererMetrics } from "../../core/types";
import { type BeautyFrameRequest, createBeautyFrameRequest } from "../compositing/beauty-frame";
import { type CachingRenderer, presentWithPreviewCache } from "./cached-beauty-presenter";

const METRICS = { fps: 60 } as RendererMetrics;

function fakeRenderer(accept = true) {
  let capture: ((frame: CachedPreviewFrame) => void) | undefined;
  const renderer: CachingRenderer & { presented: CachedPreviewFrame[] } = {
    presented: [],
    presentCachedFrame: vi.fn((frame: CachedPreviewFrame) => {
      if (!accept) return false;
      renderer.presented.push(frame);
      return true;
    }),
    capturePreviewFrame: vi.fn((onFrame) => {
      capture = onFrame;
    }),
  };
  const present = vi.fn((request: BeautyFrameRequest) => {
    capture?.({
      pixels: new ArrayBuffer(request.target.width * request.target.height * 4),
      width: request.target.width,
      height: request.target.height,
      pixelFormat: "bgra",
    });
    capture = undefined;
    return METRICS;
  });
  return { renderer, present };
}

function request(project: Project, time: number): BeautyFrameRequest {
  const composition = activeComposition(project);
  composition.frameRate = { numerator: 30, denominator: 1 };
  return createBeautyFrameRequest({ composition, project, time, width: 64, height: 36 });
}

function present(
  cache: PreviewFrameCache,
  fake: ReturnType<typeof fakeRenderer>,
  beauty: BeautyFrameRequest,
  playing = true,
) {
  return presentWithPreviewCache({
    cache,
    renderer: fake.renderer,
    request: beauty,
    playing,
    present: fake.present,
  });
}

describe("cached beauty presentation", () => {
  it("renders a playback frame at its composition frame time, then replays it", () => {
    const cache = new PreviewFrameCache(64, () => undefined);
    const fake = fakeRenderer();
    const project = createDemoProject();
    expect(present(cache, fake, request(project, 1.05))).toBe(METRICS);
    expect(fake.present.mock.calls[0][0].time).toBeCloseTo(31 / 30, 9);
    expect(present(cache, fake, request(project, 1.06))).toBeUndefined();
    expect(fake.present).toHaveBeenCalledOnce();
    expect(fake.renderer.presented).toHaveLength(1);
  });

  it("re-renders after an edit replaces the project", () => {
    const cache = new PreviewFrameCache(64, () => undefined);
    const fake = fakeRenderer();
    const project = createDemoProject();
    present(cache, fake, request(project, 2));
    const edited = structuredClone(project);
    expect(present(cache, fake, request(edited, 2))).toBe(METRICS);
    expect(fake.present).toHaveBeenCalledTimes(2);
  });

  it("renders paused off-frame times exactly and never caches them", () => {
    const cache = new PreviewFrameCache(64, () => undefined);
    const fake = fakeRenderer();
    const project = createDemoProject();
    present(cache, fake, request(project, 1.05), false);
    expect(fake.renderer.capturePreviewFrame).not.toHaveBeenCalled();
    expect(fake.present.mock.calls[0][0].time).toBe(1.05);
    present(cache, fake, request(project, 1), false);
    expect(fake.renderer.capturePreviewFrame).toHaveBeenCalledOnce();
  });

  it("falls back to rendering when disabled or when the canvas no longer fits the frame", () => {
    const disabled = new PreviewFrameCache(0, () => undefined);
    const fake = fakeRenderer();
    const project = createDemoProject();
    present(disabled, fake, request(project, 1));
    expect(fake.renderer.capturePreviewFrame).not.toHaveBeenCalled();

    const cache = new PreviewFrameCache(64, () => undefined);
    const rejecting = fakeRenderer(false);
    present(cache, rejecting, request(project, 1));
    expect(present(cache, rejecting, request(project, 1))).toBe(METRICS);
    expect(rejecting.present).toHaveBeenCalledTimes(2);
  });
});
