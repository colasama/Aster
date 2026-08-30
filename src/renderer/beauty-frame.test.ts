import { describe, expect, it } from "vitest";
import { activeComposition, createDemoProject } from "../core/project";
import type { RendererMetrics } from "../core/types";
import {
  type BeautyFrameBackend,
  type BeautyFrameRequest,
  createBeautyFrameRequest,
  createViewportBeautyFrameBackend,
  PRODUCTION_BEAUTY_SETTINGS,
  ProductionBeautyFramePipeline,
} from "./beauty-frame";
import type { CanvasFallbackRenderer } from "./canvas-fallback";
import type { RawVideoFrame } from "./frame-readback";

class FakeBeautyBackend implements BeautyFrameBackend {
  readonly maxConcurrentReadbacks = 3;
  readonly pixelFormat = "rgba" as const;
  target = { width: 1, height: 1 };
  presentedPixels: Uint8Array<ArrayBuffer> = new Uint8Array();
  requests: BeautyFrameRequest[] = [];

  currentTarget() {
    return this.target;
  }

  resize(width: number, height: number) {
    this.target = { width, height };
  }

  present(request: BeautyFrameRequest): RendererMetrics {
    this.requests.push(request);
    this.presentedPixels = fakePixels(request);
    return fakeMetrics();
  }

  async readback(request: BeautyFrameRequest): Promise<RawVideoFrame> {
    this.requests.push(request);
    return { pixels: fakePixels(request).buffer, pixelFormat: "rgba" };
  }
}

describe("production beauty frame pipeline", () => {
  it("presents and exports byte-identical pixels for the same time and resolution", async () => {
    const project = createDemoProject();
    const composition = activeComposition(project);
    const backend = new FakeBeautyBackend();
    const pipeline = new ProductionBeautyFramePipeline(backend);
    const request = createBeautyFrameRequest({
      composition,
      project,
      time: 1_001 / 30_000,
      width: 4,
      height: 3,
    });

    pipeline.present(request);
    const exported = await pipeline.readback(request);

    expect(new Uint8Array(exported.pixels)).toEqual(backend.presentedPixels);
    expect(backend.requests).toEqual([request, request]);
  });

  it("changes only target dimensions between preview qualities", () => {
    const project = createDemoProject();
    const composition = activeComposition(project);
    const preview = createBeautyFrameRequest({
      composition,
      project,
      time: 2.5,
      width: 480,
      height: 270,
    });
    const full = createBeautyFrameRequest({
      composition,
      project,
      time: 2.5,
      width: 1_920,
      height: 1_080,
    });

    expect(preview.settings).toBe(PRODUCTION_BEAUTY_SETTINGS);
    expect(full.settings).toBe(preview.settings);
    expect({ ...preview, target: undefined }).toEqual({ ...full, target: undefined });
  });

  it("rejects overrides and malformed readback buffers", async () => {
    const project = createDemoProject();
    const composition = activeComposition(project);
    const backend = new FakeBeautyBackend();
    backend.readback = async () => ({ pixels: new ArrayBuffer(3), pixelFormat: "rgba" });
    const pipeline = new ProductionBeautyFramePipeline(backend);
    const request = createBeautyFrameRequest({
      composition,
      project,
      time: 0,
      width: 1,
      height: 1,
    });

    await expect(pipeline.readback(request)).rejects.toThrow(
      "returned 3 bytes; expected 4 for 1x1 packed 8-bit pixels",
    );
    expect(() =>
      pipeline.present({
        ...request,
        settings: { ...PRODUCTION_BEAUTY_SETTINGS },
      } as BeautyFrameRequest),
    ).toThrow("cannot be overridden");
  });

  it("configures the renderer when a hidden render canvas was pre-sized to 4K", () => {
    const project = createDemoProject();
    const composition = activeComposition(project);
    const canvas = { width: 3_840, height: 2_160 } as HTMLCanvasElement;
    let outputWidth = 1;
    let outputHeight = 1;
    const renderer = {
      get outputWidth() {
        return outputWidth;
      },
      get outputHeight() {
        return outputHeight;
      },
      resize(width: number, height: number) {
        outputWidth = width;
        outputHeight = height;
      },
      render: () => fakeMetrics(),
    } as unknown as CanvasFallbackRenderer;
    const pipeline = new ProductionBeautyFramePipeline(
      createViewportBeautyFrameBackend(renderer, canvas),
    );
    const request = createBeautyFrameRequest({
      composition,
      project,
      time: 0,
      width: 3_840,
      height: 2_160,
    });

    pipeline.present(request);

    expect(renderer.outputWidth).toBe(3_840);
    expect(renderer.outputHeight).toBe(2_160);
    expect(canvas).toMatchObject({ width: 3_840, height: 2_160 });
  });
});

function fakePixels(request: BeautyFrameRequest): Uint8Array<ArrayBuffer> {
  const pixels = new Uint8Array(request.target.width * request.target.height * 4);
  const timeByte = Math.round(request.time * 100) & 0xff;
  for (let index = 0; index < pixels.length; index += 4) {
    pixels[index] = timeByte;
    pixels[index + 1] = request.target.width;
    pixels[index + 2] = request.target.height;
    pixels[index + 3] = 255;
  }
  return pixels;
}

function fakeMetrics(): RendererMetrics {
  return {
    fps: 60,
    frameMs: 16.67,
    cpuMs: 1,
    drawCalls: 1,
    passCount: 1,
    dirtyNodes: 0,
    cacheHitRate: 1,
    estimatedVramMb: 1,
    transientTextureCount: 1,
  };
}
