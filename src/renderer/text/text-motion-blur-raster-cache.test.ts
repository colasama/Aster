import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLayerForComposition } from "../../core/layers/layer-factory";
import { createBlankComposition } from "../../core/project/project";
import type { TextMotionBlurSample } from "./text-motion-blur-plan";
import {
  boundTextMotionBlurSamples,
  planTextMotionBlurRasterScale,
  TextMotionBlurRasterCache,
  textMotionBlurRasterShader,
  textMotionBlurRasterSource,
} from "./text-motion-blur-raster-cache";
import { measureTextLayerBounds, textRasterSize } from "./text-rasterizer";

vi.mock("./text-rasterizer", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./text-rasterizer")>()),
  measureTextLayerBounds: vi.fn((layer) => ({
    x: 0,
    y: 0,
    width: layer.size[0],
    height: layer.size[1],
  })),
}));

beforeEach(() => {
  vi.stubGlobal("GPUShaderStage", { FRAGMENT: 1 });
  vi.stubGlobal("GPUTextureUsage", { TEXTURE_BINDING: 1, COPY_DST: 2, RENDER_ATTACHMENT: 4 });
  vi.stubGlobal("GPUBufferUsage", { UNIFORM: 1, COPY_DST: 2, COPY_SRC: 4 });
});

afterEach(() => vi.unstubAllGlobals());

describe("GPU temporal text raster accumulation", () => {
  it("uses one expanded local-space extent for every shutter sample", () => {
    vi.mocked(measureTextLayerBounds)
      .mockReturnValueOnce({ x: -30, y: -20, width: 130, height: 70 })
      .mockReturnValueOnce({ x: 0, y: 0, width: 200, height: 80 });
    const rasterize = vi.fn((_layer, maximum: number, _time = 0, scale = 1, bounds) => {
      const { width, height } = textRasterSize(
        { size: [bounds.width, bounds.height] },
        maximum,
        scale,
      );
      return { width, height, bounds, canvas: {} as HTMLCanvasElement };
    });
    const cache = new TextMotionBlurRasterCache(
      mockDevice([]),
      {} as GPUBindGroupLayout,
      {} as GPUSampler,
      { rasterize },
    );
    const layer = createLayerForComposition("text", createBlankComposition());
    layer.size = [100, 50];
    const plan = {
      frameTime: 1,
      sampleCount: 2,
      transparentWeight: 0,
      samples: [
        { localTime: 0.9, timeBucket: 900_000, weight: 0.5 },
        { localTime: 1.1, timeBucket: 1_100_000, weight: 0.5 },
      ],
    };
    const prepared = cache.prepare(layer, "overflow", plan, 1);
    const bounds = { x: -30, y: -20, width: 230, height: 100 };
    expect(prepared.bounds).toEqual(bounds);
    expect(prepared.textureBytes).toBe(230 * 100 * 4);
    expect(rasterize.mock.calls.map((call) => call[4])).toEqual([bounds, bounds]);
    expect(cache.prepare(layer, "overflow", plan, 1)).toBe(prepared);
    expect(rasterize).toHaveBeenCalledTimes(2);
    cache.destroy();
  });
  it("accumulates straight sRGB samples as premultiplied linear color and resolves once", () => {
    expect(textMotionBlurRasterShader).toContain("straight.rgb * alpha");
    expect(textMotionBlurRasterShader).toContain("premultiplied.rgb / max(premultiplied.a");
    expect(textMotionBlurRasterShader).toContain("textureLoad(sample_texture");
    expect(textMotionBlurRasterShader).not.toContain("aces_tonemap");
  });

  it("keys held raster states by pixel inputs rather than the requesting frame", () => {
    const layer = createLayerForComposition("text", createBlankComposition());
    const samples = [
      { localTime: 1, timeBucket: 1_000_000, weight: 0.5 },
      { localTime: 2, timeBucket: 2_000_000, weight: 0.5 },
    ];
    const first = textMotionBlurRasterSource(
      layer,
      { frameTime: 1, sampleCount: 2, transparentWeight: 0, samples },
      samples,
      1,
    );
    const held = textMotionBlurRasterSource(
      layer,
      { frameTime: 99, sampleCount: 64, transparentWeight: 0, samples },
      samples,
      1,
    );

    expect(held).toBe(first);
  });

  it("bounds transient samples while preserving the shutter exposure weight", () => {
    const samples = Array.from({ length: 8 }, (_, index) => ({
      localTime: index / 100,
      timeBucket: index * 10_000,
      weight: 1 / 8,
    })) satisfies TextMotionBlurSample[];
    const pixelBytes = 1_024;
    const fixedBytes = pixelBytes * 2;
    const bounded = boundTextMotionBlurSamples(
      samples,
      pixelBytes,
      fixedBytes + 3 * (pixelBytes + 256),
    );
    expect(bounded).toHaveLength(3);
    expect(bounded.map((sample) => sample.timeBucket)).toEqual([0, 40_000, 70_000]);
    expect(bounded.reduce((total, sample) => total + sample.weight, 0)).toBeCloseTo(1);
    expect(boundTextMotionBlurSamples(samples, pixelBytes, fixedBytes)).toEqual([]);
  });

  it("selects the largest deterministic scale that preserves at least two samples", () => {
    const plan = planTextMotionBlurRasterScale(
      { size: [100, 50] },
      8_192,
      1.9,
      4,
      250_000,
      400_000,
    );

    expect(plan).toMatchObject({
      requestedScale: 1.953125,
      resolutionScale: 1.5625,
      minimumSampleCount: 2,
      reduced: true,
    });
    expect(plan.requiredTransientBytes).toBeLessThanOrEqual(250_000);
    expect(
      planTextMotionBlurRasterScale({ size: [100, 50] }, 8_192, 1.9, 4, 250_000, 400_000),
    ).toEqual(plan);
  });

  it("fails actionably when two samples cannot fit even at 1x", () => {
    expect(() =>
      planTextMotionBlurRasterScale({ size: [100, 100] }, 8_192, 8, 8, 159_999, 1_000_000),
    ).toThrow("100×100 requires 160512 transient bytes for 2 samples at 1x; budget is 159999");
  });

  it("reports a reduced generation while keeping accounting and canonical samples bounded", () => {
    const textureRecords: Array<{ label: string; destroy: ReturnType<typeof vi.fn> }> = [];
    const passRecords: Array<{ label: string; draws: number }> = [];
    const device = mockDevice(textureRecords);
    const rasterize = vi.fn(
      (layer, maximumDimension: number, _localTime = 0, resolutionScale = 1) => {
        const { width, height } = textRasterSize(layer, maximumDimension, resolutionScale);
        return { width, height, canvas: {} as HTMLCanvasElement };
      },
    );
    const cache = new TextMotionBlurRasterCache(
      device,
      {} as GPUBindGroupLayout,
      {} as GPUSampler,
      { maxTransientBytes: 250_000, maxResidentBytes: 400_000, rasterize },
    );
    const layer = createLayerForComposition("text", createBlankComposition());
    layer.size = [100, 50];
    const samples = Array.from({ length: 4 }, (_, index) => ({
      localTime: 1 + index / 1_000,
      timeBucket: 1_000_000 + index * 1_000,
      weight: 0.25,
    }));

    cache.beginFrame();
    const prepared = cache.prepare(
      layer,
      "text-instance",
      { frameTime: 1, sampleCount: 4, transparentWeight: 0, samples },
      1.9,
    );

    expect(prepared.resolutionScale).toBe(1.5625);
    expect(prepared.sampleCount).toBeGreaterThanOrEqual(2);
    expect(prepared.transientBytes).toBeLessThanOrEqual(250_000);
    expect(prepared.textureBytes + prepared.transientBytes).toBe(298_440);
    expect(cache.estimatedBytes).toBe(prepared.transientBytes);
    expect(cache.frameStats).toMatchObject({
      resolutionScaleReductionCount: 1,
      lowestResolutionScale: 1.5625,
    });
    cache.encode(mockEncoder(passRecords));
    expect(passRecords[0]).toEqual({
      label: "Temporal text premultiplied linear accumulation",
      draws: prepared.sampleCount,
    });
    cache.submitted();
    cache.destroy();
  });

  it("resolves an all-transparent shutter interval without falling back to the current glyph", () => {
    const textureRecords: Array<{ label: string; destroy: ReturnType<typeof vi.fn> }> = [];
    const passRecords: Array<{ label: string; draws: number }> = [];
    const clearAlphas: number[] = [];
    const device = mockDevice(textureRecords);
    const rasterize = vi.fn();
    const cache = new TextMotionBlurRasterCache(
      device,
      {} as GPUBindGroupLayout,
      {} as GPUSampler,
      { rasterize },
    );
    const layer = createLayerForComposition("text", createBlankComposition());
    layer.size = [2, 1];

    expect(
      cache.prepare(
        layer,
        "text-instance",
        { frameTime: 1, sampleCount: 2, transparentWeight: 1, samples: [] },
        1,
      ),
    ).toMatchObject({ sampleCount: 0 });
    cache.encode(mockEncoder(passRecords, clearAlphas));

    expect(rasterize).not.toHaveBeenCalled();
    expect(passRecords).toEqual([
      { label: "Temporal text premultiplied linear accumulation", draws: 0 },
      { label: "Temporal text straight-alpha sRGB resolve", draws: 1 },
    ]);
    expect(clearAlphas).toEqual([0, 0]);
    expect(textMotionBlurRasterShader).toContain("return vec4f(straight, premultiplied.a)");
    cache.submitted();
    expect(
      textureRecords.find((record) => record.label.includes("output"))?.destroy,
    ).not.toHaveBeenCalled();
    cache.destroy();
  });

  it("keeps uploads empty when a later raster in one generation fails", () => {
    const textureRecords: Array<{ label: string; destroy: ReturnType<typeof vi.fn> }> = [];
    const passRecords: Array<{ label: string; draws: number }> = [];
    const device = mockDevice(textureRecords);
    let failSecond = true;
    const rasterize = vi.fn((_layer, _maximum, localTime = 0) => {
      if (failSecond && localTime > 1) throw new Error("sample decode failed");
      return { width: 2, height: 1, canvas: {} as HTMLCanvasElement };
    });
    const cache = new TextMotionBlurRasterCache(
      device,
      {} as GPUBindGroupLayout,
      {} as GPUSampler,
      { rasterize },
    );
    const layer = createLayerForComposition("text", createBlankComposition());
    layer.size = [2, 1];
    const plan = {
      frameTime: 1,
      sampleCount: 2,
      transparentWeight: 0,
      samples: [
        { localTime: 1, timeBucket: 1_000_000, weight: 0.5 },
        { localTime: 2, timeBucket: 2_000_000, weight: 0.5 },
      ],
    };

    expect(() => cache.prepare(layer, "text-instance", plan, 1)).toThrow("sample decode failed");
    const failedEncoder = mockEncoder(passRecords);
    cache.encode(failedEncoder);
    expect(device.queue.copyExternalImageToTexture).not.toHaveBeenCalled();
    expect(passRecords).toEqual([]);
    expect(textureRecords).toEqual([]);

    failSecond = false;
    cache.prepare(layer, "text-instance", plan, 1);
    expect(device.queue.copyExternalImageToTexture).toHaveBeenCalledTimes(2);
    const retryEncoder = mockEncoder(passRecords);
    cache.encode(retryEncoder);
    cache.abortSubmission();
    cache.destroy();
  });

  it("encodes one GPU accumulation generation and releases only transient resources on submit", () => {
    const textureRecords: Array<{ label: string; destroy: ReturnType<typeof vi.fn> }> = [];
    const passRecords: Array<{ label: string; draws: number }> = [];
    const device = mockDevice(textureRecords);
    const rasterize = vi.fn((_layer, _maximum, localTime = 0) => ({
      width: 2,
      height: 1,
      canvas: { localTime } as unknown as HTMLCanvasElement,
    }));
    const cache = new TextMotionBlurRasterCache(
      device,
      {} as GPUBindGroupLayout,
      {} as GPUSampler,
      { rasterize },
    );
    const layer = createLayerForComposition("text", createBlankComposition());
    layer.size = [2, 1];
    const plan = {
      frameTime: 1,
      sampleCount: 2,
      transparentWeight: 0,
      samples: [
        { localTime: 0.99, timeBucket: 990_000, weight: 0.5 },
        { localTime: 1.01, timeBucket: 1_010_000, weight: 0.5 },
      ],
    };
    cache.beginFrame();
    const prepared = cache.prepare(layer, "text-instance", plan, 1);
    expect(prepared?.sampleCount).toBe(2);
    expect(rasterize).toHaveBeenCalledTimes(2);

    const encoder = mockEncoder(passRecords);
    cache.encode(encoder);
    expect(passRecords).toEqual([
      { label: "Temporal text premultiplied linear accumulation", draws: 2 },
      { label: "Temporal text straight-alpha sRGB resolve", draws: 1 },
    ]);
    cache.submitted();
    expect(
      textureRecords
        .filter(
          (record) => record.label.includes("sample") || record.label.includes("accumulation"),
        )
        .every((record) => record.destroy.mock.calls.length === 1),
    ).toBe(true);
    const output = textureRecords.find((record) => record.label.includes("output"));
    expect(output?.destroy).not.toHaveBeenCalled();

    const heldPlan = { ...plan, frameTime: 20, sampleCount: 64 };
    const held = cache.prepare(layer, "text-instance", heldPlan, 1);
    expect(held.source).toBe(prepared.source);
    expect(held.bindGroup).toBe(prepared.bindGroup);
    cache.encode(mockEncoder(passRecords));
    expect(rasterize).toHaveBeenCalledTimes(2);
    const retryPlan = {
      ...plan,
      frameTime: 1.1,
      samples: plan.samples.map((sample) => ({
        ...sample,
        localTime: sample.localTime + 0.1,
        timeBucket: sample.timeBucket + 100_000,
      })),
    };
    cache.beginFrame();
    const replacementPrepared = cache.prepare(layer, "text-instance", retryPlan, 1);
    expect(output?.destroy).not.toHaveBeenCalled();
    const outputsBeforeAbort = textureRecords.filter((record) => record.label.includes("output"));
    const replacement = outputsBeforeAbort[outputsBeforeAbort.length - 1];
    expect(outputsBeforeAbort).toHaveLength(1);
    expect(replacementPrepared?.bindGroup).toBe(prepared?.bindGroup);
    expect(replacement?.destroy).not.toHaveBeenCalled();
    cache.encode(mockEncoder(passRecords));
    const outputs = textureRecords.filter((record) => record.label.includes("output"));
    const abortedOutput = outputs[outputs.length - 1];
    cache.abortSubmission();
    expect(abortedOutput?.destroy).toHaveBeenCalledTimes(1);
    cache.prepare(layer, "text-instance", retryPlan, 1);
    expect(rasterize).toHaveBeenCalledTimes(6);
    expect(textureRecords.filter((record) => record.label.includes("output"))).toHaveLength(2);
    cache.sweep(new Set());
    expect(output?.destroy).toHaveBeenCalledTimes(1);
    cache.destroy();
    cache.destroy();
  });
});

function mockDevice(
  textures: Array<{ label: string; destroy: ReturnType<typeof vi.fn> }>,
): GPUDevice {
  return {
    limits: { maxTextureDimension2D: 8_192, maxBufferSize: 1_073_741_824 },
    queue: {
      copyExternalImageToTexture: vi.fn(),
      writeBuffer: vi.fn(),
      writeTexture: vi.fn(),
    },
    createBindGroupLayout: vi.fn(() => ({})),
    createPipelineLayout: vi.fn(() => ({})),
    createShaderModule: vi.fn(() => ({})),
    createRenderPipeline: vi.fn(() => ({})),
    createBindGroup: vi.fn(() => ({})),
    createTexture: vi.fn((descriptor: GPUTextureDescriptor) => {
      const record = { label: String(descriptor.label ?? ""), destroy: vi.fn() };
      textures.push(record);
      return { createView: vi.fn(() => ({})), destroy: record.destroy };
    }),
    createBuffer: vi.fn((descriptor: GPUBufferDescriptor) => ({
      size: descriptor.size,
      destroy: vi.fn(),
    })),
  } as unknown as GPUDevice;
}

function mockEncoder(
  records: Array<{ label: string; draws: number }>,
  clearAlphas?: number[],
): GPUCommandEncoder {
  return {
    copyBufferToTexture: vi.fn(),
    beginRenderPass: vi.fn((descriptor: GPURenderPassDescriptor) => {
      const clearValue = descriptor.colorAttachments[0]?.clearValue;
      if (clearAlphas && clearValue && typeof clearValue !== "string")
        clearAlphas.push((clearValue as { a: number }).a);
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
