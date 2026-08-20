import { describe, expect, it } from "vitest";
import { planGpuMemory } from "./gpu-memory-budget";

describe("GPU memory budget planning", () => {
  it("preserves requested quality when the allocation fits", () => {
    const plan = planGpuMemory({
      width: 1920,
      height: 1080,
      effectTextureBytes: 0,
      persistentBufferBytes: 16 * 1024 * 1024,
      requestedShadowMapSize: 2048,
      budgetMb: 128,
    });
    expect(plan.shadowMapSize).toBe(2048);
    expect(plan.pressure).toBe("normal");
  });

  it("degrades shadow allocation before exceeding the budget", () => {
    const plan = planGpuMemory({
      width: 1920,
      height: 1080,
      effectTextureBytes: 5 * 1024 * 1024,
      persistentBufferBytes: 5 * 1024 * 1024,
      requestedShadowMapSize: 2048,
      budgetMb: 56,
    });
    expect(plan.shadowMapSize).toBe(1024);
    expect(plan.estimatedBytes).toBeLessThanOrEqual(56 * 1024 * 1024);
  });

  it("reports critical pressure when persistent allocations alone exceed the budget", () => {
    const plan = planGpuMemory({
      width: 3840,
      height: 2160,
      effectTextureBytes: 64 * 1024 * 1024,
      persistentBufferBytes: 32 * 1024 * 1024,
      requestedShadowMapSize: 1024,
      budgetMb: 64,
    });
    expect(plan.shadowMapSize).toBe(1);
    expect(plan.pressure).toBe("critical");
  });
});
