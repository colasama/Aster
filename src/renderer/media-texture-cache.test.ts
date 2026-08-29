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
  vi.stubGlobal("GPUBufferUsage", { UNIFORM: 1, COPY_DST: 2, COPY_SRC: 4 });
  vi.stubGlobal("GPUShaderStage", { FRAGMENT: 1 });
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

  it("lazily encodes exact text samples and releases their transient generation after submit", () => {
    vi.stubGlobal("document", {
      createElement: (name: string) => {
        if (name !== "canvas") throw new Error(`Unexpected element ${name}`);
        return new MockTextCanvas();
      },
    });
    const textures: Array<{ label: string; destroy: ReturnType<typeof vi.fn> }> = [];
    const passes: Array<{ label: string; draws: number }> = [];
    const createShaderModule = vi.fn(() => ({}));
    const device = {
      limits: { maxTextureDimension2D: 8_192, maxBufferSize: 1_073_741_824 },
      queue: {
        copyExternalImageToTexture: vi.fn(),
        writeBuffer: vi.fn(),
        writeTexture: vi.fn(),
      },
      createBindGroupLayout: vi.fn(() => ({})),
      createPipelineLayout: vi.fn(() => ({})),
      createShaderModule,
      createRenderPipeline: vi.fn(() => ({})),
      createTexture: vi.fn((descriptor: GPUTextureDescriptor) => {
        const record = { label: String(descriptor.label ?? ""), destroy: vi.fn() };
        textures.push(record);
        return { createView: vi.fn(() => ({})), destroy: record.destroy };
      }),
      createBuffer: vi.fn((descriptor: GPUBufferDescriptor) => ({
        size: descriptor.size,
        destroy: vi.fn(),
      })),
      createBindGroup: vi.fn(() => ({})),
    } as unknown as GPUDevice;
    const cache = new MediaTextureCache(
      device,
      {} as GPUBindGroupLayout,
      {} as GPUSampler,
      vi.fn(),
    );
    const layer = createLayerForComposition("text", createBlankComposition());
    layer.size = [8, 4];
    const encoder = mockTextEncoder(passes);

    cache.prepareText(layer, "text-instance", 1, 24, 1);
    cache.flush(encoder);
    cache.submitted();
    expect(createShaderModule).not.toHaveBeenCalled();
    expect(passes).toEqual([]);

    cache.prepareText(layer, "text-instance", 1, 24, 1, {
      frameTime: 1,
      sampleCount: 2,
      transparentWeight: 0,
      samples: [
        { localTime: 0.99, timeBucket: 990_000, weight: 0.5 },
        { localTime: 1.01, timeBucket: 1_010_000, weight: 0.5 },
      ],
    });
    cache.flush(encoder);
    expect(passes).toEqual([
      { label: "Temporal text premultiplied linear accumulation", draws: 2 },
      { label: "Temporal text straight-alpha sRGB resolve", draws: 1 },
    ]);
    expect(cache.textMotionBlurFrameStats).toEqual({
      drawCount: 3,
      passCount: 2,
      transientTextureCount: 3,
      resolutionScaleReductionCount: 0,
    });
    cache.submitted();
    const output = textures.find((record) => record.label.includes("Temporal text output"));
    expect(output?.destroy).not.toHaveBeenCalled();
    expect(
      textures
        .filter(
          (record) =>
            record.label.includes("Temporal text sample") ||
            record.label.includes("Temporal text linear accumulation"),
        )
        .every((record) => record.destroy.mock.calls.length === 1),
    ).toBe(true);
    const firstBindGroup = cache.bindGroup("text-instance");
    cache.beginFrame();
    cache.prepareText(layer, "text-instance", 1.1, 24, 1, {
      frameTime: 1.1,
      sampleCount: 2,
      transparentWeight: 0,
      samples: [
        { localTime: 1.09, timeBucket: 1_090_000, weight: 0.5 },
        { localTime: 1.11, timeBucket: 1_110_000, weight: 0.5 },
      ],
    });
    expect(cache.bindGroup("text-instance")).toBe(firstBindGroup);
    expect(output?.destroy).not.toHaveBeenCalled();
    cache.flush(encoder);
    cache.submitted();
    expect(textures.filter((record) => record.label.includes("Temporal text output"))).toHaveLength(
      1,
    );
    expect(output?.destroy).not.toHaveBeenCalled();
    cache.destroy();
    expect(output?.destroy).toHaveBeenCalledTimes(1);
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

class MockTextCanvas {
  height = 1;
  width = 1;

  getContext(): CanvasRenderingContext2D {
    return {
      fillText: vi.fn(),
      filter: "none",
      getImageData: vi.fn(() => ({ data: new Uint8ClampedArray(this.width * this.height * 4) })),
      globalAlpha: 1,
      measureText: vi.fn((text: string) => ({ width: text.length })),
      restore: vi.fn(),
      rotate: vi.fn(),
      save: vi.fn(),
      scale: vi.fn(),
      strokeText: vi.fn(),
      transform: vi.fn(),
      translate: vi.fn(),
    } as unknown as CanvasRenderingContext2D;
  }
}

function mockTextEncoder(records: Array<{ label: string; draws: number }>): GPUCommandEncoder {
  return {
    copyBufferToTexture: vi.fn(),
    beginRenderPass: vi.fn((descriptor: GPURenderPassDescriptor) => {
      const record = { label: String(descriptor.label ?? ""), draws: 0 };
      records.push(record);
      return {
        setPipeline: vi.fn(),
        setBindGroup: vi.fn(),
        draw: vi.fn(() => {
          record.draws += 1;
        }),
        end: vi.fn(),
      };
    }),
  } as unknown as GPUCommandEncoder;
}
