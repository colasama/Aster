import { describe, expect, it, vi } from "vitest";
import { AntiAliasingRenderer, planAntiAliasing } from "./anti-aliasing";

describe("output anti-aliasing", () => {
  it("keeps output dimensions separate from internal sample density and rejects oversized targets", () => {
    expect(planAntiAliasing("fxaa", 1920, 1080, 8192)).toMatchObject({
      renderWidth: 1920,
      renderHeight: 1080,
      scale: 1,
    });
    expect(planAntiAliasing("ssaa2x", 1920, 1080, 8192)).toMatchObject({
      renderWidth: 3840,
      renderHeight: 2160,
      textureBytes: 3840 * 2160 * 4,
    });
    expect(planAntiAliasing("ssaa4x", 37, 29, 8192)).toMatchObject({
      renderWidth: 148,
      renderHeight: 116,
    });
    expect(() => planAntiAliasing("ssaa4x", 3840, 2160, 8192)).toThrow("GPU limit");
    expect(() => planAntiAliasing("ssaa2x", 1920, 1080, 8192, 32)).toThrow("GPU budget");
  });

  it("reuses targets, releases them when disabled, and encodes no disabled pass", () => {
    vi.stubGlobal("GPUTextureUsage", { RENDER_ATTACHMENT: 16, TEXTURE_BINDING: 4 });
    try {
      const destroy = vi.fn();
      const createTexture = vi.fn(() => ({ createView: () => ({}), destroy }));
      const device = {
        createTexture,
        createShaderModule: vi.fn(() => ({})),
        createRenderPipeline: vi.fn(() => ({ getBindGroupLayout: () => ({}) })),
        createBindGroup: vi.fn(() => ({})),
        createSampler: vi.fn(() => ({})),
      } as unknown as GPUDevice;
      const aa = new AntiAliasingRenderer(device, "rgba8unorm");
      aa.resize("off", 64, 32);
      expect(createTexture).not.toHaveBeenCalled();
      aa.resize("fxaa", 64, 32);
      aa.resize("fxaa", 64, 32);
      expect(createTexture).toHaveBeenCalledTimes(1);
      expect(aa.estimatedBytes).toBe(64 * 32 * 4);
      const pass = { setPipeline: vi.fn(), setBindGroup: vi.fn(), draw: vi.fn(), end: vi.fn() };
      const encoder = { beginRenderPass: vi.fn(() => pass) };
      aa.encode(encoder as unknown as GPUCommandEncoder, {} as GPUTextureView);
      expect(pass.draw).toHaveBeenCalledWith(3);
      aa.resize("ssaa2x", 128, 64);
      expect(destroy).toHaveBeenCalledTimes(1);
      aa.resize("off", 64, 32);
      expect(destroy).toHaveBeenCalledTimes(2);
      expect(aa.view).toBeUndefined();
      expect(aa.estimatedBytes).toBe(0);
      aa.encode(encoder as unknown as GPUCommandEncoder, {} as GPUTextureView);
      expect(encoder.beginRenderPass).toHaveBeenCalledTimes(1);
      aa.destroy();
      expect(destroy).toHaveBeenCalledTimes(2);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
