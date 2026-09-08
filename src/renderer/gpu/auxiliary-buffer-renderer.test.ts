import { describe, expect, it, vi } from "vitest";
import { logger } from "../../core/logger";
import type { Layer } from "../../core/types";
import {
  planAuxiliarySurfaceAllocation,
  productionDepthOfFieldAllocationError,
} from "./auxiliary-buffer-budget";
import {
  AuxiliaryBufferRenderer,
  auxiliaryDepthOfFieldSurfaceBytes,
  auxiliarySurfaceShader,
  buildAuxiliaryBatchIds,
  transparencyFallbackDiagnostic,
} from "./auxiliary-buffer-renderer";

const layer = (id: string, roughness: number): Layer =>
  ({
    id,
    kind: "shape",
    material: { metallic: 0, roughness, emissive: 0 },
  }) as Layer;

describe("auxiliary MRT identities", () => {
  it("shares root selection IDs across clones and material IDs across materials", () => {
    const ids = buildAuxiliaryBatchIds([
      { selectionId: "source", layer: layer("a", 0.5) },
      { selectionId: "source", layer: layer("b", 0.5) },
      { selectionId: "other", layer: layer("c", 0.8) },
    ]);
    expect(ids[0]).toBe(ids[2]);
    expect(ids[2]).not.toBe(ids[4]);
    expect(ids[1]).toBe(ids[3]);
    expect(ids[3]).not.toBe(ids[5]);
    expect([...ids].every((id) => id !== 0)).toBe(true);
  });

  it("writes interpolated shutter-endpoint UV motion for geometry", () => {
    expect(auxiliarySurfaceShader).toContain("@location(4) motion_vector: vec2f");
    expect(auxiliarySurfaceShader).toContain("@location(14) motion_vector: vec2f");
    expect(auxiliarySurfaceShader).not.toContain("previous_position");
    expect(auxiliarySurfaceShader).toContain("output.motion_vector = input.motion_vector");
  });

  it("preserves alpha coverage and a premultiplied world position for overlapping DOF", () => {
    expect(auxiliarySurfaceShader).toContain(
      "output.world_position = vec4f(input.world_position, clamp(coverage, 0.0, 1.0))",
    );
    expect(auxiliarySurfaceShader).toContain(
      "return vec4f(input.world_position * bounded_coverage, bounded_coverage)",
    );
    expect(auxiliarySurfaceShader).toContain("transparent_media_fragment");
    expect(auxiliarySurfaceShader).toContain("var front_depth: texture_depth_2d");
    expect(auxiliarySurfaceShader).toContain("peeled_media_fragment");
    expect(auxiliarySurfaceShader).toContain("struct PeeledOutput");
    expect(auxiliarySurfaceShader).toContain("front_color_media_fragment");
    expect(auxiliarySurfaceShader).toContain("output.color = color");
    expect(auxiliarySurfaceShader).toContain("input.position.z <= nearest_depth + 0.000001");
  });

  it("reports the bounded aggregate fallback used by generator residual color", () => {
    expect(transparencyFallbackDiagnostic(0)).toBeUndefined();
    expect(transparencyFallbackDiagnostic(3)).toContain("scene generators");
    expect(transparencyFallbackDiagnostic(3)).toContain("residual beauty color");
  });

  it("selects the highest preflighted DOF transparency tier", () => {
    expect(planAuxiliarySurfaceAllocation(1920, 1080, 192 * 1024 * 1024, true)).toMatchObject({
      depthOfFieldTier: 2,
    });
    const k1 = planAuxiliarySurfaceAllocation(1920, 1080, 110 * 1024 * 1024, true);
    expect(k1).toMatchObject({
      depthOfFieldTier: 1,
      diagnostic: expect.stringContaining("K1 DOF"),
    });
    expect(k1?.diagnostic).toContain("K2 needs");
    expect(k1?.diagnostic).toContain("110.0 MiB is available");
    expect(k1?.diagnostic).toContain("restore K2");
    const k0 = planAuxiliarySurfaceAllocation(1920, 1080, 64 * 1024 * 1024, true);
    expect(k0).toMatchObject({
      depthOfFieldTier: 0,
      diagnostic: expect.stringContaining("K0 DOF"),
    });
    expect(k0?.diagnostic).toContain("K1 needs");
    expect(k0?.diagnostic).toContain("restore K1/K2");
    expect(planAuxiliarySurfaceAllocation(3840, 2160, 256 * 1024 * 1024, false)).toMatchObject({
      depthOfFieldTier: -1,
    });
  });

  it("budgets and destroys the transparency surface with the MRT resources", () => {
    const previousUsage = (globalThis as { GPUTextureUsage?: unknown }).GPUTextureUsage;
    const previousShaderStage = (globalThis as { GPUShaderStage?: unknown }).GPUShaderStage;
    (globalThis as { GPUTextureUsage?: unknown }).GPUTextureUsage = {
      RENDER_ATTACHMENT: 1,
      TEXTURE_BINDING: 2,
    };
    (globalThis as { GPUShaderStage?: unknown }).GPUShaderStage = { FRAGMENT: 1 };
    const textures: Array<{
      destroy: ReturnType<typeof vi.fn>;
      createView: ReturnType<typeof vi.fn>;
    }> = [];
    const device = {
      limits: { maxColorAttachments: 8, maxColorAttachmentBytesPerSample: 64 },
      createShaderModule: vi.fn(() => ({})),
      createRenderPipeline: vi.fn(() => ({})),
      createPipelineLayout: vi.fn(() => ({})),
      createBindGroupLayout: vi.fn(() => ({})),
      createTexture: vi.fn(() => {
        const texture = { destroy: vi.fn(), createView: vi.fn(() => ({})) };
        textures.push(texture);
        return texture;
      }),
      queue: { writeBuffer: vi.fn() },
    };
    try {
      const renderer = new AuxiliaryBufferRenderer(
        device as unknown as GPUDevice,
        {} as GPUBindGroupLayout,
      );
      expect(renderer.enable(64, 32, 2 * 1024 * 1024, true)).toBe(true);
      expect(renderer.transparentWorldPosition).toBe(textures[6]);
      expect(renderer.frontLayerColor).toBe(textures[7]);
      expect(renderer.peeledWorldPosition).toBe(textures[8]);
      expect(renderer.peeledLayerColor).toBe(textures[9]);
      expect(renderer.estimatedBytes).toBe(auxiliaryDepthOfFieldSurfaceBytes(64, 32));
      renderer.destroy();
      expect(textures).toHaveLength(11);
      expect(textures.every((texture) => texture.destroy.mock.calls.length === 1)).toBe(true);
    } finally {
      (globalThis as { GPUTextureUsage?: unknown }).GPUTextureUsage = previousUsage;
      (globalThis as { GPUShaderStage?: unknown }).GPUShaderStage = previousShaderStage;
    }
  });

  it("tiers 4K DOF, preserves non-DOF budgets, and releases resize targets", () => {
    const previousUsage = (globalThis as { GPUTextureUsage?: unknown }).GPUTextureUsage;
    const previousShaderStage = (globalThis as { GPUShaderStage?: unknown }).GPUShaderStage;
    (globalThis as { GPUTextureUsage?: unknown }).GPUTextureUsage = {
      RENDER_ATTACHMENT: 1,
      TEXTURE_BINDING: 2,
    };
    (globalThis as { GPUShaderStage?: unknown }).GPUShaderStage = { FRAGMENT: 1 };
    const textures: Array<{
      destroy: ReturnType<typeof vi.fn>;
      createView: ReturnType<typeof vi.fn>;
    }> = [];
    const device = {
      limits: { maxColorAttachments: 8, maxColorAttachmentBytesPerSample: 64 },
      createShaderModule: vi.fn(() => ({})),
      createRenderPipeline: vi.fn(() => ({})),
      createPipelineLayout: vi.fn(() => ({})),
      createBindGroupLayout: vi.fn(() => ({})),
      createTexture: vi.fn(() => {
        const texture = { destroy: vi.fn(), createView: vi.fn(() => ({})) };
        textures.push(texture);
        return texture;
      }),
      queue: { writeBuffer: vi.fn() },
    };
    const warning = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    try {
      const renderer = new AuxiliaryBufferRenderer(
        device as unknown as GPUDevice,
        {} as GPUBindGroupLayout,
      );
      expect(renderer.enable(1920, 1080, 192 * 1024 * 1024, true)).toBe(true);
      const fullHdBytes = renderer.estimatedBytes;
      expect(fullHdBytes).toBe(auxiliaryDepthOfFieldSurfaceBytes(1920, 1080));
      expect(renderer.enable(1280, 720, 192 * 1024 * 1024, true)).toBe(true);
      expect(renderer.estimatedBytes).toBeLessThan(fullHdBytes);
      expect(
        textures.slice(0, 11).every((texture) => texture.destroy.mock.calls.length === 1),
      ).toBe(true);
      expect(renderer.enable(3840, 2160, 256 * 1024 * 1024, true)).toBe(true);
      expect(renderer.depthOfFieldTier).toBe(0);
      expect(renderer.depthOfFieldDiagnostic).toContain("K0 DOF");
      expect(renderer.depthOfFieldDiagnostic).toContain("256.0 MiB auxiliary budget");
      const residentTextureCount = textures.length;
      expect(renderer.enable(3840, 2160, 300 * 1024 * 1024, true)).toBe(true);
      expect(renderer.depthOfFieldDiagnostic).toContain("300.0 MiB auxiliary budget");
      expect(textures).toHaveLength(residentTextureCount);
      expect(
        productionDepthOfFieldAllocationError(
          true,
          renderer.depthOfFieldTier,
          renderer.depthOfFieldDiagnostic,
        ),
      ).toContain("requires K2");
      expect(renderer.estimatedBytes).toBeLessThan(256 * 1024 * 1024);
      expect(renderer.enable(3840, 2160, 256 * 1024 * 1024, false)).toBe(true);
      expect(renderer.depthOfFieldTier).toBe(-1);
      expect(renderer.depthOfFieldDiagnostic).toBeUndefined();
      expect(
        productionDepthOfFieldAllocationError(false, renderer.depthOfFieldTier),
      ).toBeUndefined();
      expect(renderer.enable(3840, 2160, 64 * 1024 * 1024, false)).toBe(false);
      expect(renderer.enabled).toBe(false);
      expect(renderer.enable(3840, 2160, 64 * 1024 * 1024, false)).toBe(false);
      expect(
        warning.mock.calls.filter((call) => call[1] === "auxiliary_buffer_budget_exceeded"),
      ).toHaveLength(1);
      expect(auxiliaryDepthOfFieldSurfaceBytes(3840, 2160)).toBeGreaterThan(512 * 1024 * 1024);
    } finally {
      warning.mockRestore();
      (globalThis as { GPUTextureUsage?: unknown }).GPUTextureUsage = previousUsage;
      (globalThis as { GPUShaderStage?: unknown }).GPUShaderStage = previousShaderStage;
    }
  });
});
