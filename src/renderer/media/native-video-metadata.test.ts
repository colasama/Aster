import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createLayerForComposition } from "../../core/layers/layer-factory";
import { createBlankComposition } from "../../core/project/project";
import { frameTimeToNumber } from "../frame-plan/time";
import { createCache, MockCanvas, MockVideo, videoSource } from "./media-test-fixtures";

beforeEach(() => {
  vi.stubGlobal("GPUTextureUsage", {
    TEXTURE_BINDING: 1,
    COPY_DST: 2,
    COPY_SRC: 4,
    RENDER_ATTACHMENT: 8,
  });
  vi.stubGlobal("GPUBufferUsage", { UNIFORM: 1, COPY_DST: 2, COPY_SRC: 4 });
  vi.stubGlobal("GPUShaderStage", { FRAGMENT: 1 });
});
afterEach(() => vi.unstubAllGlobals());
it("plans native video clocks without seeking or pixels and recreates decoding on TS fallback", async () => {
  const videos: MockVideo[] = [];
  vi.stubGlobal("HTMLMediaElement", { HAVE_CURRENT_DATA: 2 });
  const create = vi.fn((name: string) => {
    if (name !== "video") return new MockCanvas();
    const video = new MockVideo();
    videos.push(video);
    return video;
  });
  vi.stubGlobal("document", { body: { append: vi.fn() }, createElement: create });
  const cache = createCache();
  const layer = createLayerForComposition("video", createBlankComposition());
  try {
    cache.beginFrame(true, true);
    cache.prepareMedia(layer, videoSource(), 0, false, "native");
    expect(cache.hasPendingFrameResources).toBe(true);
    expect(videos[0].preload).toBe("metadata");
    videos[0].dispatchEvent(new Event("loadedmetadata"));
    await cache.waitForFrameResources();
    expect(cache.mediaReady("native")).toBe(true);
    expect(cache.videoFrameExact("native")).toBe(true);
    expect(create.mock.calls.map(([name]) => name)).toEqual(["video"]);
    for (const [time, expected] of [
      [0, 0],
      [0.001, 0],
      [1, 1.0001],
      [1.001, 1.0001],
      [2, 2.0001],
      [0.5, 0.5001],
      [16 / 30, 0.533433],
      [17 / 30, 0.566766],
      [0, 0.0001],
      [0.001, 0.0001],
    ]) {
      cache.prepareMedia(layer, videoSource(), time, false, "native");
      const lease = cache.acquireFrameBindings(["native"], "scope");
      const frame = lease.resourceMessages.find((r) => r.kind === "media_frame");
      if (frame?.kind !== "media_frame" || frame.descriptor.sample.kind !== "video")
        throw Error("Missing video");
      expect(frameTimeToNumber(frame.descriptor.sample.requested_time)).toBe(time + 0.0001);
      expect(frameTimeToNumber(frame.descriptor.sample.uploaded_time)).toBe(expected);
      expect(() => lease.textureForHash(frame.hash)).toThrow("no browser pixels");
      cache.abortFrame();
      expect(videos[0].currentTime).toBe(0);
    }
    cache.beginFrame();
    cache.prepareMedia(layer, videoSource(), 2, false, "native");
    expect(videos).toHaveLength(2);
    expect(videos[1].preload).toBe("auto");
    expect(cache.mediaReady("native")).toBe(false);
    videos[1].readyState = 2;
    videos[1].dispatchEvent(new Event("loadeddata"));
    await cache.waitForFrameResources();
    const lease = cache.acquireFrameBindings(["native"], "scope");
    expect(lease.textureForHash(lease.hashFor("native") as string)).toBeDefined();
    expect(videos[1].currentTime).toBe(2.0001);
    cache.abortFrame();
  } finally {
    cache.destroy();
  }
});

it("rejects invalid native metadata and releases pending metadata waits on destruction", async () => {
  const video = new MockVideo();
  vi.stubGlobal("document", { createElement: () => video });
  const cache = createCache();
  const layer = createLayerForComposition("video", createBlankComposition());
  cache.beginFrame(true, true);
  cache.prepareMedia(layer, videoSource(), 0, false, "native");
  video.videoWidth = 0;
  video.dispatchEvent(new Event("loadedmetadata"));
  await expect(cache.waitForFrameResources()).rejects.toThrow("metadata exceeds limits");
  cache.destroy();
  const pending = createCache();
  pending.beginFrame(true, true);
  pending.prepareMedia(layer, videoSource(), 0, false, "pending");
  const waited = pending.waitForFrameResources();
  pending.destroy();
  await waited;
  expect(pending.hasPendingFrameResources).toBe(false);
});
