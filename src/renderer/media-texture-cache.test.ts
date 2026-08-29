import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLayerForComposition } from "../core/layer-factory";
import { createBlankComposition } from "../core/project";
import type { FootageSource } from "../core/types";
import { mediaImportRuntime } from "../importers/media-import-runtime";
import { MediaTextureCache, svgPreviewRasterTarget } from "./media-texture-cache";

beforeEach(() => {
  vi.stubGlobal("GPUTextureUsage", {
    TEXTURE_BINDING: 1,
    COPY_DST: 2,
    COPY_SRC: 4,
    RENDER_ATTACHMENT: 8,
  });
});

afterEach(() => vi.unstubAllGlobals());

describe("exact-frame media resource barrier", () => {
  it("requests high-magnification SVG rasters instead of stretching the base texture", () => {
    const target = svgPreviewRasterTarget(400, 200, 8, 4_096);
    expect(target.width).toBeGreaterThanOrEqual(3_200);
    expect(target.height).toBeGreaterThanOrEqual(1_600);
    expect(target.width).toBeLessThanOrEqual(4_096);
  });

  it("waits for the current still generation and ignores stale completion", async () => {
    const first = deferred<ImageBitmap>();
    const second = deferred<ImageBitmap>();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => ({
        ok: true,
        blob: async () => ({ url }),
      })),
    );
    vi.stubGlobal(
      "createImageBitmap",
      vi.fn((blob: { url: string }) =>
        blob.url.endsWith("first.png") ? first.promise : second.promise,
      ),
    );
    const cache = createCache();
    const layer = createLayerForComposition("image", createBlankComposition());
    cache.prepareMedia(layer, still("first.png"), 0, false, "image-instance");
    cache.prepareMedia(layer, still("second.png"), 0, false, "image-instance");
    let settled = false;
    const waiting = cache.waitForFrameResources(1_000).then(() => {
      settled = true;
    });

    first.resolve(bitmap());
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);
    second.resolve(bitmap());
    await waiting;
    expect(settled).toBe(true);
    expect(cache.bindGroup("image-instance")).toBeDefined();
  });

  it("rejects decode errors, timeouts, and aborts instead of reading placeholders", async () => {
    const decode = deferred<ImageBitmap>();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, blob: async () => ({}) })),
    );
    vi.stubGlobal(
      "createImageBitmap",
      vi.fn(() => decode.promise),
    );
    const cache = createCache();
    const layer = createLayerForComposition("image", createBlankComposition());
    cache.prepareMedia(layer, still("broken.png"), 0, false, "broken");
    decode.reject(new Error("decode exploded"));
    await expect(cache.waitForFrameResources()).rejects.toThrow("decode exploded");

    const never = deferred<ImageBitmap>();
    vi.stubGlobal(
      "createImageBitmap",
      vi.fn(() => never.promise),
    );
    cache.prepareMedia(layer, still("slow.png"), 0, false, "slow");
    await expect(cache.waitForFrameResources(5)).rejects.toThrow("Timed out");
    const controller = new AbortController();
    const aborted = cache.waitForFrameResources(1_000, controller.signal);
    controller.abort("cancel export");
    await expect(aborted).rejects.toMatchObject({ name: "AbortError", message: "cancel export" });
  });

  it("marks a video generation pending until an exact decoded frame is uploaded", () => {
    const video = new MockVideo();
    vi.stubGlobal("HTMLMediaElement", { HAVE_CURRENT_DATA: 2 });
    vi.stubGlobal("document", {
      body: { append: vi.fn() },
      createElement: (name: string) => (name === "video" ? video : new MockCanvas()),
    });
    const cache = createCache();
    const layer = createLayerForComposition("video", createBlankComposition());
    cache.prepareMedia(layer, videoSource(), 0, false, "video-instance");
    expect(cache.hasPendingFrameResources).toBe(true);

    video.readyState = 2;
    video.dispatchEvent(new Event("loadeddata"));

    expect(cache.hasPendingFrameResources).toBe(false);
  });

  it("closes a late still decode after destroy without touching GPU state or reporting errors", async () => {
    const decode = deferred<ImageBitmap>();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, blob: async () => ({}) })),
    );
    const decodeBitmap = vi.fn(() => decode.promise);
    vi.stubGlobal("createImageBitmap", decodeBitmap);
    const createTexture = vi.fn(() => ({ createView: vi.fn(() => ({})), destroy: vi.fn() }));
    const invalidate = vi.fn();
    const reportError = vi.spyOn(mediaImportRuntime, "reportError");
    const device = {
      limits: { maxTextureDimension2D: 8_192 },
      queue: { copyExternalImageToTexture: vi.fn(), writeTexture: vi.fn() },
      createTexture,
      createBuffer: vi.fn(() => ({ destroy: vi.fn() })),
      createBindGroup: vi.fn(() => ({})),
    } as unknown as GPUDevice;
    const cache = new MediaTextureCache(
      device,
      {} as GPUBindGroupLayout,
      {} as GPUSampler,
      invalidate,
    );
    const layer = createLayerForComposition("image", createBlankComposition());
    cache.prepareMedia(layer, still("late.png"), 0, false, "late-instance");
    await vi.waitFor(() => expect(decodeBitmap).toHaveBeenCalledTimes(1));
    cache.destroy();
    const late = bitmap();

    decode.resolve(late);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(late.close).toHaveBeenCalledTimes(1);
    expect(createTexture).not.toHaveBeenCalled();
    expect(invalidate).not.toHaveBeenCalled();
    expect(reportError).not.toHaveBeenCalled();
    expect(cache.bindGroup("late-instance")).toBeUndefined();
    expect(() => cache.prepareMedia(layer, still("again.png"), 0, false, "again")).toThrow(
      "destroyed",
    );
  });
});

function createCache(): MediaTextureCache {
  const texture = { createView: vi.fn(() => ({})), destroy: vi.fn() };
  const device = {
    limits: { maxTextureDimension2D: 8_192 },
    queue: { copyExternalImageToTexture: vi.fn(), writeTexture: vi.fn() },
    createTexture: vi.fn(() => texture),
    createBuffer: vi.fn(() => ({ destroy: vi.fn() })),
    createBindGroup: vi.fn(() => ({})),
  } as unknown as GPUDevice;
  return new MediaTextureCache(device, {} as GPUBindGroupLayout, {} as GPUSampler, vi.fn());
}

function still(name: string): FootageSource {
  return {
    id: name,
    kind: "still",
    name,
    mimeType: "image/png",
    contentIdentity: name,
    runtimeUrl: `https://assets.invalid/${name}`,
    width: 16,
    height: 16,
    interpretation: { alpha: "straight", colorSpace: "srgb" },
  };
}

function videoSource(): FootageSource {
  return {
    id: "video-source",
    kind: "video",
    name: "video.mp4",
    mimeType: "video/mp4",
    contentIdentity: "video-source",
    runtimeUrl: "https://assets.invalid/video.mp4",
    width: 16,
    height: 16,
    duration: 4,
    interpretation: { alpha: "straight", colorSpace: "srgb" },
  };
}

function bitmap(): ImageBitmap {
  return { width: 16, height: 16, close: vi.fn() } as unknown as ImageBitmap;
}

function deferred<Value>() {
  let resolve!: (value: Value) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<Value>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

class MockVideo extends EventTarget {
  currentTime = 0;
  readonly dataset: DOMStringMap = {};
  duration = 4;
  error: MediaError | null = null;
  muted = true;
  paused = true;
  playsInline = false;
  preload = "";
  readyState = 0;
  seeking = false;
  src = "";
  readonly style = {};
  videoHeight = 16;
  videoWidth = 16;
  volume = 0;

  load(): void {}
  pause(): void {
    this.paused = true;
  }
  play(): Promise<void> {
    this.paused = false;
    return Promise.resolve();
  }
  remove(): void {}
  removeAttribute(_name: string): void {}
  setAttribute(_name: string, _value: string): void {}
}

class MockCanvas {
  height = 1;
  width = 1;

  getContext(): CanvasRenderingContext2D {
    return {
      drawImage: vi.fn(),
      getImageData: vi.fn(() => ({ data: new Uint8ClampedArray(this.width * this.height * 4) })),
    } as unknown as CanvasRenderingContext2D;
  }

  remove(): void {}
  setAttribute(_name: string, _value: string): void {}
}
