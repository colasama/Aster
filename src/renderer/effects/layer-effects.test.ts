import { afterEach, describe, expect, it, vi } from "vitest";
import { createLayerForComposition } from "../../core/layers/layer-factory";
import { createBlankProject } from "../../core/project/project";
import { createEffect } from "../../effects/registry";
import { LayerEffectRenderer } from "./layer-effects";

describe("GPU adjustment-layer effects", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("uses one fused pass between two explicit HDR texture copies", () => {
    installGpuConstants();
    const events: string[] = [];
    const textures: Array<{ label?: string; usage: number }> = [];
    const device = mockDevice(textures);
    const renderer = new LayerEffectRenderer(device, "rgba16float");
    renderer.resize(320, 180);
    const project = createBlankProject();
    const composition = project.compositions[0];
    const adjustment = createLayerForComposition("adjustment", composition);
    adjustment.effects = [createEffect("exposure"), createEffect("posterize")];
    const pass = {
      setPipeline: vi.fn(() => events.push("pipeline")),
      setBindGroup: vi.fn(),
      draw: vi.fn(() => events.push("draw")),
      end: vi.fn(() => events.push("pass-end")),
    };
    const encoder = {
      copyTextureToTexture: vi.fn(() => events.push("copy")),
      beginRenderPass: vi.fn(() => {
        events.push("pass-begin");
        return pass;
      }),
    } as unknown as GPUCommandEncoder;

    const operationCount = renderer.encodeAdjustment(
      encoder,
      { label: "scene" } as GPUTexture,
      composition,
      adjustment,
      "root/adjustment",
      0,
    );

    expect(operationCount).toBe(2);
    expect(events).toEqual(["copy", "pass-begin", "pipeline", "draw", "pass-end", "copy"]);
    expect(
      textures.filter((texture) => Boolean(texture.usage & GPUTextureUsage.COPY_SRC)).map(toUsage),
    ).toEqual([
      expect.objectContaining({ copySource: true, copyDestination: true }),
      expect.objectContaining({ copySource: true, copyDestination: true }),
    ]);
    expect(renderer.estimatedTextureBytes()).toBe(320 * 180 * 20);
  });

  it("records no GPU work when every adjustment effect is disabled", () => {
    installGpuConstants();
    const renderer = new LayerEffectRenderer(mockDevice([]), "rgba16float");
    const composition = createBlankProject().compositions[0];
    const adjustment = createLayerForComposition("adjustment", composition);
    const effect = createEffect("exposure");
    effect.enabled = false;
    adjustment.effects = [effect];
    const encoder = {
      copyTextureToTexture: vi.fn(),
      beginRenderPass: vi.fn(),
    } as unknown as GPUCommandEncoder;

    expect(
      renderer.encodeAdjustment(
        encoder,
        {} as GPUTexture,
        composition,
        adjustment,
        "root/adjustment",
        0,
      ),
    ).toBe(0);
    expect(encoder.copyTextureToTexture).not.toHaveBeenCalled();
    expect(encoder.beginRenderPass).not.toHaveBeenCalled();
  });

  it("keeps multiple adjustments ordered and skips enabled effects with no GPU opcode", () => {
    installGpuConstants();
    const events: string[] = [];
    const renderer = new LayerEffectRenderer(mockDevice([]), "rgba16float");
    renderer.resize(64, 64);
    const composition = createBlankProject().compositions[0];
    const first = createLayerForComposition("adjustment", composition);
    first.name = "First";
    first.effects = [createEffect("exposure")];
    const second = createLayerForComposition("adjustment", composition);
    second.name = "Second";
    second.effects = [createEffect("posterize")];
    const pass = {
      setPipeline: vi.fn(),
      setBindGroup: vi.fn(),
      draw: vi.fn(() => events.push("draw")),
      end: vi.fn(),
    };
    const encoder = {
      copyTextureToTexture: vi.fn(() => events.push("copy")),
      beginRenderPass: vi.fn(() => pass),
    } as unknown as GPUCommandEncoder;
    const target = {} as GPUTexture;

    renderer.encodeAdjustment(encoder, target, composition, first, "first", 0);
    renderer.encodeAdjustment(encoder, target, composition, second, "second", 0);
    expect(events).toEqual(["copy", "draw", "copy", "copy", "draw", "copy"]);

    const unsupported = createLayerForComposition("adjustment", composition);
    unsupported.effects = [
      { id: "unknown", type: "unknown", name: "Unknown", enabled: true, parameters: {} },
    ];
    events.length = 0;
    expect(renderer.encodeAdjustment(encoder, target, composition, unsupported, "unknown", 0)).toBe(
      0,
    );
    expect(events).toEqual([]);
  });

  it("destroys old ping-pong and depth textures when resized", () => {
    installGpuConstants();
    const destroy = vi.fn();
    const renderer = new LayerEffectRenderer(mockDevice([], destroy), "rgba16float");
    renderer.resize(64, 32);
    renderer.resize(128, 64);

    expect(destroy).toHaveBeenCalledTimes(3);
    expect(renderer.estimatedTextureBytes()).toBe(128 * 64 * 20);
  });
});

function installGpuConstants(): void {
  vi.stubGlobal("GPUShaderStage", { FRAGMENT: 1 });
  vi.stubGlobal("GPUTextureUsage", {
    COPY_SRC: 1,
    COPY_DST: 2,
    TEXTURE_BINDING: 4,
    RENDER_ATTACHMENT: 8,
  });
  vi.stubGlobal("GPUBufferUsage", { COPY_DST: 1, UNIFORM: 2, STORAGE: 4 });
}

function mockDevice(
  textures: Array<{ label?: string; usage: number }>,
  destroy = vi.fn(),
): GPUDevice {
  const texture = (descriptor: GPUTextureDescriptor) => {
    textures.push({ label: descriptor.label, usage: descriptor.usage });
    return { createView: vi.fn(() => ({})), destroy };
  };
  return {
    queue: { writeTexture: vi.fn(), writeBuffer: vi.fn() },
    createSampler: vi.fn(() => ({})),
    createTexture: vi.fn(texture),
    createBindGroupLayout: vi.fn(() => ({})),
    createShaderModule: vi.fn(() => ({})),
    createPipelineLayout: vi.fn(() => ({})),
    createRenderPipeline: vi.fn(() => ({})),
    createBindGroup: vi.fn(() => ({})),
    createBuffer: vi.fn(() => ({ destroy: vi.fn() })),
  } as unknown as GPUDevice;
}

function toUsage(texture: { usage: number }): {
  copySource: boolean;
  copyDestination: boolean;
} {
  return {
    copySource: Boolean(texture.usage & GPUTextureUsage.COPY_SRC),
    copyDestination: Boolean(texture.usage & GPUTextureUsage.COPY_DST),
  };
}
