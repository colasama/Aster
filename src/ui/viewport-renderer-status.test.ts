import { describe, expect, it } from "vitest";
import type { GpuDiagnostics } from "../core/types";
import { createTranslator } from "../i18n/core";
import { viewportRendererStatus } from "./viewport-renderer-status";

const t = createTranslator("en-US");

function diagnostics(patch: Partial<GpuDiagnostics> = {}): GpuDiagnostics {
  return {
    available: true,
    adapter: "Test GPU",
    architecture: "test",
    description: "Test adapter",
    maxTextureSize: 8192,
    timestampQueries: true,
    pipelineCompileMs: 4.25,
    prewarmedPipelines: 12,
    ...patch,
  };
}

describe("viewport renderer status", () => {
  it("shows full K2 and actionable K1/K0 degradation states", () => {
    expect(viewportRendererStatus(diagnostics({ depthOfFieldTier: 2 }), t)).toMatchObject({
      label: "WebGPU · Test GPU",
      title: expect.stringContaining("DOF K2: full transparent-surface separation"),
      tone: "gpu",
    });

    for (const tier of [1, 0] as const) {
      const reason = `K${tier} DOF selected because the higher tier exceeds the budget`;
      expect(
        viewportRendererStatus(
          diagnostics({ depthOfFieldTier: tier, depthOfFieldDegradedReason: reason }),
          t,
        ),
      ).toEqual({
        label: `DOF K${tier} · Reduced`,
        title: reason,
        tone: "performance-warning",
      });
    }
  });

  it("surfaces unavailable DOF and keeps resource errors highest priority", () => {
    expect(
      viewportRendererStatus(
        diagnostics({
          depthOfFieldTier: -1,
          depthOfFieldDegradedReason: "Required MRT is unavailable",
        }),
        t,
      ),
    ).toEqual({
      label: "DOF unavailable",
      title: "Required MRT is unavailable",
      tone: "performance-warning",
    });
    expect(
      viewportRendererStatus(
        diagnostics({
          materialResourceError: "texture failed",
          depthOfFieldTier: 0,
          depthOfFieldDegradedReason: "budget",
        }),
        t,
      ),
    ).toMatchObject({ tone: "resource-error" });
  });

  it("matches the viewer reset title to the canonical default magnification", () => {
    expect(t("viewport.resetZoom")).toBe("Reset to 25%");
  });
});
