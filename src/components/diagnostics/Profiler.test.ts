// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  GpuBenchmarkReport,
  GpuBenchmarkRequest,
} from "../../renderer/diagnostics/gpu-benchmark";
import { requestGpuBenchmark } from "./Profiler";

const report: GpuBenchmarkReport = {
  schemaVersion: 1,
  generatedAt: "2026-08-30T00:00:00.000Z",
  adapter: "Test adapter",
  backend: "test",
  warmupFrames: 10,
  sampleFrames: 60,
  scenarios: [],
};

afterEach(() => vi.useRealTimers());

describe("GPU benchmark request", () => {
  it("resolves through an accepting composition viewer", async () => {
    const listener = (event: Event) => {
      const request = (event as CustomEvent<GpuBenchmarkRequest>).detail;
      request.accept();
      request.resolve(report);
    };
    window.addEventListener("aster:run-gpu-benchmark", listener);
    await expect(requestGpuBenchmark(60, vi.fn())).resolves.toBe(report);
    window.removeEventListener("aster:run-gpu-benchmark", listener);
  });

  it("rejects instead of waiting forever when no viewer accepts the request", async () => {
    vi.useFakeTimers();
    const benchmark = requestGpuBenchmark(60, vi.fn(), 250);
    const rejection = expect(benchmark).rejects.toThrow(
      "No open composition viewer accepted the GPU benchmark.",
    );
    await vi.advanceTimersByTimeAsync(250);
    await rejection;
  });
});
