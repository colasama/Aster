import { describe, expect, it, vi } from "vitest";
import { activeComposition, createDemoProject } from "../../core/project/project";
import type { RendererMetrics } from "../../core/types";
import type { CanvasFallbackRenderer } from "../canvas-fallback";
import type { RawVideoFrame } from "../gpu/frame-readback";
import { WebGpuRenderer } from "../webgpu-renderer";
import {
  type BeautyFrameBackend,
  type BeautyFrameRequest,
  createBeautyFrameRequest,
  createViewportBeautyFrameBackend,
  PRODUCTION_BEAUTY_SETTINGS,
  ProductionBeautyFramePipeline,
} from "./beauty-frame";

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
  it("captures caller snapshot identity and preserves arbitrary finite seek values", () => {
    const project = createDemoProject();
    const snapshot = { snapshotScope: "editor:load:3", projectRevision: 41 };
    const requests = [-0, 0.1, Number.MIN_VALUE, Number.MAX_VALUE].map((time) =>
      createBeautyFrameRequest({
        snapshot,
        project,
        composition: activeComposition(project),
        time,
        width: 2,
        height: 2,
      }),
    );
    snapshot.projectRevision = 42;
    snapshot.snapshotScope = "editor:load:4";
    for (const request of requests) {
      expect(request.snapshot).toEqual({ snapshotScope: "editor:load:3", projectRevision: 41 });
      expect(request.snapshot).not.toBe(snapshot);
      expect(Object.isFrozen(request.snapshot)).toBe(true);
    }
    expect(requests.map((request) => request.time)).toEqual([
      -0,
      0.1,
      Number.MIN_VALUE,
      Number.MAX_VALUE,
    ]);
  });

  it("rejects missing or invalid snapshot identity before preparing the backend", () => {
    const project = createDemoProject();
    const backend = new FakeBeautyBackend();
    const resize = vi.spyOn(backend, "resize");
    const pipeline = new ProductionBeautyFramePipeline(backend);
    const request = createBeautyFrameRequest({
      snapshot: { snapshotScope: "immutable:session", projectRevision: 0 },
      project,
      composition: activeComposition(project),
      time: 0,
      width: 2,
      height: 2,
    });
    for (const snapshot of [undefined, { snapshotScope: "", projectRevision: 0 }]) {
      expect(() => pipeline.present({ ...request, snapshot } as BeautyFrameRequest)).toThrow();
    }
    expect(resize).not.toHaveBeenCalled();
    expect(backend.requests).toHaveLength(0);
  });

  it("rejects an invalid destination before preparing resources or calling the backend", async () => {
    const project = createDemoProject();
    const backend = new FakeBeautyBackend();
    const resize = vi.spyOn(backend, "resize");
    const readback = vi.spyOn(backend, "readback");
    const pipeline = new ProductionBeautyFramePipeline(backend);
    const request = createBeautyFrameRequest({
      snapshot: { snapshotScope: "beauty-test", projectRevision: 7 },
      project,
      composition: activeComposition(project),
      time: 0,
      width: 2,
      height: 2,
    });
    await expect(pipeline.readback(request, true, new ArrayBuffer(15))).rejects.toThrow(
      /destination/,
    );
    expect(resize).not.toHaveBeenCalled();
    expect(readback).not.toHaveBeenCalled();
    await expect(pipeline.readback(request, true, new ArrayBuffer(16))).rejects.toThrow(
      /did not use/,
    );
  });

  it("passes caller-owned output storage and exact-media synchronization to WebGPU", async () => {
    const project = createDemoProject();
    const destination = new ArrayBuffer(16);
    const renderRawFrame = vi.fn(
      async (
        _composition: unknown,
        _time: number,
        _snapshot: unknown,
        _project: unknown,
        _synchronizeVideo: boolean,
        buffer: ArrayBuffer,
      ) => {
        new Uint8Array(buffer).fill(51);
        return { pixels: buffer, pixelFormat: "rgba" as const };
      },
    );
    const renderer = Object.assign(Object.create(WebGpuRenderer.prototype), {
      configureBeautyTarget: vi.fn(),
      renderRawFrame,
    }) as WebGpuRenderer;
    Object.defineProperties(renderer, {
      exportPixelFormat: { value: "rgba" },
      outputWidth: { value: 2 },
      outputHeight: { value: 2 },
      bufferVisualization: { value: "beauty" },
    });
    const pipeline = new ProductionBeautyFramePipeline(
      createViewportBeautyFrameBackend(renderer, { width: 2, height: 2 } as HTMLCanvasElement),
    );
    const request = createBeautyFrameRequest({
      snapshot: { snapshotScope: "beauty-test", projectRevision: 7 },
      project,
      composition: activeComposition(project),
      time: 0.5,
      width: 2,
      height: 2,
      antiAliasing: "ssaa4x",
    });
    expect((await pipeline.readback(request, true, destination)).pixels).toBe(destination);
    expect(renderRawFrame).toHaveBeenCalledWith(
      request.composition,
      0.5,
      request.snapshot,
      project,
      true,
      destination,
    );
    expect(new Uint8Array(destination)).toEqual(new Uint8Array(16).fill(51));
  });

  it("settles preview submission once before concurrent export readbacks", async () => {
    let finish!: () => void;
    const completion = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const renderer = Object.assign(Object.create(WebGpuRenderer.prototype), {
      configureBeautyTarget: vi.fn(),
      render: () => fakeMetrics(),
      complete: vi.fn(() => completion),
      renderRawFrame: vi.fn(async () => ({
        pixels: new ArrayBuffer(16),
        pixelFormat: "rgba" as const,
      })),
    }) as WebGpuRenderer;
    Object.defineProperties(renderer, {
      exportPixelFormat: { value: "rgba" },
      outputWidth: { value: 2 },
      outputHeight: { value: 2 },
      bufferVisualization: { value: "beauty" },
    });
    const pipeline = new ProductionBeautyFramePipeline(
      createViewportBeautyFrameBackend(renderer, { width: 2, height: 2 } as HTMLCanvasElement),
    );
    const project = createDemoProject();
    const request = createBeautyFrameRequest({
      snapshot: { snapshotScope: "beauty-test", projectRevision: 7 },
      project,
      composition: activeComposition(project),
      time: 0,
      width: 2,
      height: 2,
      antiAliasing: "fxaa",
    });
    pipeline.present(request);
    const first = pipeline.readback(request);
    const second = pipeline.readback(request);
    expect(renderer.complete).toHaveBeenCalledOnce();
    expect(renderer.renderRawFrame).not.toHaveBeenCalled();
    finish();
    await Promise.all([first, second]);
    await pipeline.readback(request);
    expect(renderer.complete).toHaveBeenCalledOnce();
    expect(renderer.renderRawFrame).toHaveBeenCalledTimes(3);
  });
  it("configures the same AA target before presentation and export", async () => {
    const project = createDemoProject();
    const backend = new FakeBeautyBackend();
    const prepareTarget = vi.fn((target: { width: number; height: number }) =>
      backend.resize(target.width, target.height),
    );
    const pipeline = new ProductionBeautyFramePipeline(Object.assign(backend, { prepareTarget }));
    for (const antiAliasing of ["off", "fxaa", "ssaa2x", "ssaa4x"] as const) {
      const request = createBeautyFrameRequest({
        snapshot: { snapshotScope: "beauty-test", projectRevision: 7 },
        project,
        composition: activeComposition(project),
        time: 0,
        width: 7,
        height: 5,
        antiAliasing,
      });
      pipeline.present(request);
      expect(prepareTarget).toHaveBeenLastCalledWith({ width: 7, height: 5 }, antiAliasing);
      expect((await pipeline.readback(request)).pixels.byteLength).toBe(7 * 5 * 4);
      expect(prepareTarget).toHaveBeenLastCalledWith({ width: 7, height: 5 }, antiAliasing);
    }
  });
  it("presents and exports byte-identical pixels for the same time and resolution", async () => {
    const project = createDemoProject();
    const composition = activeComposition(project);
    const backend = new FakeBeautyBackend();
    const pipeline = new ProductionBeautyFramePipeline(backend);
    const request = createBeautyFrameRequest({
      snapshot: { snapshotScope: "beauty-test", projectRevision: 7 },
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
      snapshot: { snapshotScope: "beauty-test", projectRevision: 7 },
      composition,
      project,
      time: 2.5,
      width: 480,
      height: 270,
    });
    const full = createBeautyFrameRequest({
      snapshot: { snapshotScope: "beauty-test", projectRevision: 7 },
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
      snapshot: { snapshotScope: "beauty-test", projectRevision: 7 },
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

  it("passes playback to video decoders without changing deterministic readback", async () => {
    const project = createDemoProject();
    const composition = activeComposition(project);
    const pixels = new Uint8ClampedArray(4);
    const canvas = {
      width: 1,
      height: 1,
      getContext: () => ({ getImageData: () => ({ data: pixels }) }),
    } as unknown as HTMLCanvasElement;
    const render = vi.fn(() => fakeMetrics());
    const renderer = {
      outputWidth: 1,
      outputHeight: 1,
      render,
      complete: async () => undefined,
    } as unknown as CanvasFallbackRenderer;
    const pipeline = new ProductionBeautyFramePipeline(
      createViewportBeautyFrameBackend(renderer, canvas),
    );
    const request = createBeautyFrameRequest({
      snapshot: { snapshotScope: "beauty-test", projectRevision: 7 },
      composition,
      project,
      time: 4,
      width: 1,
      height: 1,
    });
    pipeline.present(request, undefined, true);
    expect(render).toHaveBeenLastCalledWith(composition, 4, true, project, undefined, true);
    pipeline.present(request);
    expect(render).toHaveBeenLastCalledWith(composition, 4, false, project, undefined, true);
    await pipeline.readback(request);
    expect(render).toHaveBeenLastCalledWith(composition, 4, false, project);
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
      snapshot: { snapshotScope: "beauty-test", projectRevision: 7 },
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
