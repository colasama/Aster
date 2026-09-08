import { describe, expect, it } from "vitest";
import { activeComposition, createDemoProject } from "../../core/project/project";
import { particleSettingsFromGenerator } from "../../core/scene/bundled-particle";
import { buildBenchmarkScenarios, summarizeSamples } from "./gpu-benchmark";

describe("GPU benchmark harness", () => {
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
