import { describe, expect, it } from "vitest";
import type { GpuDiagnostics } from "../../src/core/types";
import { CaptureHealth } from "./capture-health";

const diagnostics: GpuDiagnostics = {
  available: true,
  adapter: "test-adapter",
  architecture: "test-architecture",
  description: "test GPU",
  maxTextureSize: 8192,
  timestampQueries: false,
};

describe("reference capture health", () => {
  it.each([
    "materialResourceError",
    "adjustmentLayerError",
    "precompositionSurfaceError",
    "sceneGeneratorError",
  ] as const)("rejects %s even when beauty readback returned pixels", (key) => {
    const health = new CaptureHealth();
    expect(() => health.assertHealthy({ ...diagnostics, [key]: "missing resource" })).toThrow(key);
  });

  it("does not erase a frame's failure when later diagnostics have cleared", () => {
    const health = new CaptureHealth();
    health.observe({ level: "warn", scope: "audio", event: "audio_analysis_decode_failed" });
    expect(() => health.assertHealthy(diagnostics)).toThrow("audio_analysis_decode_failed");
    health.beginCase();
    expect(() => health.assertHealthy(diagnostics)).not.toThrow();
  });

  it("retains valid adaptive quality tiers while rejecting failed allocations", () => {
    const health = new CaptureHealth();
    health.observe({
      level: "warn",
      scope: "webgpu",
      event: "depth_of_field_transparency_degraded",
      data: { tier: 1 },
    });
    expect(() => health.assertHealthy({ ...diagnostics, depthOfFieldTier: 1 })).not.toThrow();
    expect(() => health.assertHealthy(diagnostics, "Required DoF targets unavailable")).toThrow(
      "Required DoF targets unavailable",
    );
  });

  it("makes GPU loss terminal and rejects uncaptured validation errors", () => {
    const health = new CaptureHealth();
    health.observe({ level: "error", scope: "webgpu", event: "uncaptured_error" });
    expect(() => health.assertHealthy()).toThrow("uncaptured_error");
    health.observe({ level: "warn", scope: "webgpu", event: "device_lost" });
    expect(health.fatal).toBe(true);
    expect(() => health.beginCase()).toThrow("lost");
  });
});
