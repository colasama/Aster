import type { GpuBenchmarkReport } from "./gpu-benchmark";

export interface GpuBenchmarkComparison {
  compatible: boolean;
  gpuMedianDeltaPercent: Record<string, number>;
}

export function compareGpuBenchmarks(
  current: GpuBenchmarkReport,
  baseline: GpuBenchmarkReport,
): GpuBenchmarkComparison {
  const compatible = current.adapter === baseline.adapter && current.backend === baseline.backend;
  const baselineScenarios = new Map(
    baseline.scenarios.map((scenario) => [scenarioKey(scenario), scenario]),
  );
  const gpuMedianDeltaPercent: Record<string, number> = {};
  if (compatible) {
    for (const scenario of current.scenarios) {
      const reference = baselineScenarios.get(scenarioKey(scenario));
      if (!reference || reference.gpuMs.median <= 0) continue;
      gpuMedianDeltaPercent[scenario.name] =
        ((scenario.gpuMs.median - reference.gpuMs.median) / reference.gpuMs.median) * 100;
    }
  }
  return { compatible, gpuMedianDeltaPercent };
}

export function parseGpuBenchmarkBaseline(value: string | null): GpuBenchmarkReport | undefined {
  if (!value) return undefined;
  try {
    const report = JSON.parse(value) as Partial<GpuBenchmarkReport>;
    if (
      report.schemaVersion !== 1 ||
      typeof report.adapter !== "string" ||
      typeof report.backend !== "string" ||
      !Array.isArray(report.scenarios) ||
      report.scenarios.some(
        (scenario) =>
          typeof scenario?.name !== "string" ||
          !Number.isFinite(scenario?.width) ||
          !Number.isFinite(scenario?.height) ||
          !Number.isFinite(scenario?.gpuMs?.median),
      )
    )
      return undefined;
    return report as GpuBenchmarkReport;
  } catch {
    return undefined;
  }
}

function scenarioKey(scenario: { name: string; width: number; height: number }): string {
  return `${scenario.name}:${scenario.width}x${scenario.height}`;
}
