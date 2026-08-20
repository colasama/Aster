import { describe, expect, it } from "vitest";
import type { GpuBenchmarkReport } from "./gpu-benchmark";
import { compareGpuBenchmarks, parseGpuBenchmarkBaseline } from "./gpu-benchmark-baseline";

describe("GPU performance baselines", () => {
  it("reports signed median regressions for matching hardware and scenarios", () => {
    const baseline = report(10, "Adapter A");
    expect(compareGpuBenchmarks(report(12, "Adapter A"), baseline)).toEqual({
      compatible: true,
      gpuMedianDeltaPercent: { "4K current composition": 20 },
    });
    expect(compareGpuBenchmarks(report(8, "Adapter A"), baseline).gpuMedianDeltaPercent).toEqual({
      "4K current composition": -20,
    });
  });

  it("does not compare measurements from different adapters", () => {
    expect(compareGpuBenchmarks(report(12, "Adapter B"), report(10, "Adapter A"))).toEqual({
      compatible: false,
      gpuMedianDeltaPercent: {},
    });
  });

  it("rejects malformed persisted baselines", () => {
    expect(parseGpuBenchmarkBaseline("{")).toBeUndefined();
    expect(parseGpuBenchmarkBaseline(JSON.stringify({ schemaVersion: 1 }))).toBeUndefined();
    expect(parseGpuBenchmarkBaseline(JSON.stringify(report(10, "Adapter A")))).toMatchObject({
      adapter: "Adapter A",
    });
  });
});

function report(gpuMedian: number, adapter: string): GpuBenchmarkReport {
  const distribution = {
    minimum: gpuMedian,
    median: gpuMedian,
    p95: gpuMedian,
    p99: gpuMedian,
    maximum: gpuMedian,
  };
  return {
    schemaVersion: 1,
    generatedAt: "2026-08-20T00:00:00.000Z",
    adapter,
    backend: "WebGPU",
    warmupFrames: 10,
    sampleFrames: 60,
    scenarios: [
      {
        name: "4K current composition",
        width: 3840,
        height: 2160,
        layers: 7,
        effects: 4,
        wallMs: distribution,
        cpuMs: distribution,
        gpuMs: distribution,
      },
    ],
  };
}
