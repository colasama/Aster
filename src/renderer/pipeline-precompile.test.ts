import { describe, expect, it, vi } from "vitest";
import { precompileGpuPipelines } from "./pipeline-precompile";

describe("asynchronous GPU pipeline precompilation", () => {
  it("compiles render and compute families concurrently", async () => {
    const createRenderPipelineAsync = vi.fn(async () => ({}));
    const createComputePipelineAsync = vi.fn(async () => ({}));
    const device = {
      createShaderModule: vi.fn(() => ({})),
      createRenderPipelineAsync,
      createComputePipelineAsync,
    } as unknown as GPUDevice;

    const report = await precompileGpuPipelines(device, "bgra8unorm");
    expect(report.count).toBe(7);
    expect(report.durationMs).toBeGreaterThanOrEqual(0);
    expect(createRenderPipelineAsync).toHaveBeenCalledTimes(6);
    expect(createComputePipelineAsync).toHaveBeenCalledTimes(1);
  });
});
