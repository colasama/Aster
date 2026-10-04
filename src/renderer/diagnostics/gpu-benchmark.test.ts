import { describe, expect, it } from "vitest";
import { activeComposition, createDemoProject } from "../../core/project/project";
import type { RenderSnapshotIdentity } from "../../core/rendering/render-snapshot";
import { particleSettingsFromGenerator } from "../../core/scene/bundled-particle";
import type { RendererMetrics } from "../../core/types";
import { buildBenchmarkScenarios, runGpuBenchmark, summarizeSamples } from "./gpu-benchmark";

describe("GPU benchmark harness", () => {
  it("owns derived scenario scopes and restores the captured editor revision after awaits", async () => {
    const project = createDemoProject();
    const composition = activeComposition(project);
    const original = { snapshotScope: "editor:load", projectRevision: 7 };
    const rendered: Array<{ compositionId: string; snapshot: RenderSnapshotIdentity }> = [];
    await runGpuBenchmark(
      {
        resize: () => undefined,
        render: (scene, _time, snapshot) => {
          rendered.push({ compositionId: scene.id, snapshot });
          return { cpuMs: 1 } as RendererMetrics;
        },
        complete: async () => {
          original.projectRevision = 8;
        },
      },
      { width: 64, height: 36 } as HTMLCanvasElement,
      composition,
      project,
      original,
      0,
      "test",
      "test",
      1,
      () => undefined,
    );
    const restore = rendered.pop();
    expect(restore).toEqual({
      compositionId: composition.id,
      snapshot: { snapshotScope: "editor:load", projectRevision: 7 },
    });
    const scopes = new Map<string, string>();
    for (const frame of rendered) {
      const previous = scopes.get(frame.compositionId);
      if (previous) expect(frame.snapshot.snapshotScope).toBe(previous);
      else scopes.set(frame.compositionId, frame.snapshot.snapshotScope);
      expect(frame.snapshot.projectRevision).toBe(0);
    }
    expect(new Set(scopes.values()).size).toBe(7);
  });

  it("builds representative resolution, layer, and effect scenarios", () => {
    const scenarios = buildBenchmarkScenarios(activeComposition(createDemoProject()));
    expect(scenarios.map((scenario) => scenario.name)).toEqual([
      "1080p current composition",
      "4K current composition",
      "20-layer 1080p composite",
      "Blur + glow effect chain",
      "100K GPU particles",
      "500K GPU particles",
      "1M GPU particles",
    ]);
    expect(scenarios[1].composition).toMatchObject({ width: 3840, height: 2160 });
    expect(scenarios[2].composition.layers).toHaveLength(20);
    expect(scenarios[3].composition.layers[0].effects).toHaveLength(5);
    expect(
      scenarios
        .slice(4)
        .map(
          (scenario) =>
            particleSettingsFromGenerator(scenario.composition.layers[0].generator)?.count,
        ),
    ).toEqual([100_000, 500_000, 1_000_000]);
  });

  it("reports interpolated benchmark distributions", () => {
    const distribution = summarizeSamples([40, 10, 30, 20]);
    expect(distribution).toMatchObject({
      minimum: 10,
      median: 25,
      p95: 38.5,
      maximum: 40,
    });
    expect(distribution.p99).toBeCloseTo(39.7);
  });
});
