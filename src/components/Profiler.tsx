import {
  Activity,
  BookmarkPlus,
  BookmarkX,
  Cpu,
  Download,
  Gauge,
  Layers3,
  MemoryStick,
  Zap,
} from "lucide-react";
import { useMemo, useState } from "react";
import type { GpuBenchmarkReport, GpuBenchmarkRequest } from "../renderer/gpu-benchmark";
import {
  compareGpuBenchmarks,
  parseGpuBenchmarkBaseline,
} from "../renderer/gpu-benchmark-baseline";
import { useEditor } from "../state/editor-store";

const BENCHMARK_BASELINE_KEY = "aster.gpuBenchmarkBaseline.v1";

export function Profiler() {
  const { state } = useEditor();
  const metrics = state.metrics;
  const [benchmark, setBenchmark] = useState<GpuBenchmarkReport>();
  const [baseline, setBaseline] = useState<GpuBenchmarkReport | undefined>(() =>
    parseGpuBenchmarkBaseline(localStorage.getItem(BENCHMARK_BASELINE_KEY)),
  );
  const [benchmarkProgress, setBenchmarkProgress] = useState<string>();
  const comparison = useMemo(
    () => (benchmark && baseline ? compareGpuBenchmarks(benchmark, baseline) : undefined),
    [baseline, benchmark],
  );
  const runBenchmark = (sampleFrames: number) => {
    if (benchmarkProgress) return;
    setBenchmark(undefined);
    setBenchmarkProgress("Preparing GPU…");
    void new Promise<GpuBenchmarkReport | undefined>((resolve) => {
      window.dispatchEvent(
        new CustomEvent<GpuBenchmarkRequest>("aster:run-gpu-benchmark", {
          detail: {
            sampleFrames,
            onProgress: (scenario, completed, total) =>
              setBenchmarkProgress(`${scenario} · ${Math.round((completed / total) * 100)}%`),
            resolve,
          },
        }),
      );
    }).then((report) => {
      setBenchmark(report);
      setBenchmarkProgress(undefined);
    });
  };
  return (
    <div className={`profiler-overlay ${benchmark ? "benchmark-expanded" : ""}`}>
      <div className="profiler-title">
        <Activity size={12} /> REALTIME <span>GPU</span>
        <button
          disabled={Boolean(benchmarkProgress)}
          onClick={() => runBenchmark(60)}
          title="Run a quick 60-frame benchmark per scenario"
          type="button"
        >
          QUICK
        </button>
        <button
          disabled={Boolean(benchmarkProgress)}
          onClick={() => runBenchmark(600)}
          title="Run the full 600-frame benchmark per scenario"
          type="button"
        >
          FULL
        </button>
      </div>
      <Metric icon={Gauge} label="FPS" value={metrics.fps.toFixed(0)} accent />
      <Metric icon={Zap} label="Frame" value={`${metrics.frameMs.toFixed(2)} ms`} />
      <Metric
        icon={Zap}
        label="GPU execution"
        value={metrics.gpuMs === undefined ? "warming…" : `${metrics.gpuMs.toFixed(2)} ms`}
      />
      <Metric icon={Cpu} label="CPU submit" value={`${metrics.cpuMs.toFixed(2)} ms`} />
      <Metric
        icon={MemoryStick}
        label="VRAM est."
        value={`${metrics.estimatedVramMb.toFixed(0)} / ${metrics.memoryBudgetMb?.toFixed(0) ?? "auto"} MB`}
      />
      <Metric
        icon={MemoryStick}
        label="Pressure / shadow"
        value={`${metrics.memoryPressure ?? "normal"} / ${formatShadowMap(metrics.shadowMapSize)}`}
      />
      <Metric
        icon={Layers3}
        label="Passes / dirty"
        value={`${metrics.passCount} / ${metrics.dirtyNodes}`}
      />
      <Metric
        icon={Layers3}
        label="Transient"
        value={`${metrics.transientTextureCount} textures`}
      />
      {metrics.passTimings && (
        <div className="pass-breakdown">
          <PassTiming label="Compute" value={metrics.passTimings.computeMs} />
          <PassTiming label="Shadow" value={metrics.passTimings.shadowMs} />
          <PassTiming label="Scene" value={metrics.passTimings.sceneMs} />
          <PassTiming label="Post / ACES" value={metrics.passTimings.postMs} />
        </div>
      )}
      <div className="cache-bar">
        <span style={{ width: `${metrics.cacheHitRate * 100}%` }} />
        <small>Node cache {Math.round(metrics.cacheHitRate * 100)}%</small>
      </div>
      {benchmarkProgress && <div className="benchmark-progress">{benchmarkProgress}</div>}
      {benchmark && (
        <div className="benchmark-report">
          <div className="benchmark-report-title">
            <span>
              {benchmark.sampleFrames} frame report
              {baseline && ` · ${comparison?.compatible ? "vs baseline" : "hardware mismatch"}`}
            </span>
            <button
              aria-label={
                baseline ? "Replace GPU benchmark baseline" : "Save GPU benchmark baseline"
              }
              onClick={() => {
                localStorage.setItem(BENCHMARK_BASELINE_KEY, JSON.stringify(benchmark));
                setBaseline(benchmark);
              }}
              title={baseline ? "Replace the stored baseline" : "Save this report as the baseline"}
              type="button"
            >
              <BookmarkPlus size={10} />
            </button>
            {baseline && (
              <button
                aria-label="Clear GPU benchmark baseline"
                onClick={() => {
                  localStorage.removeItem(BENCHMARK_BASELINE_KEY);
                  setBaseline(undefined);
                }}
                title="Clear the stored performance baseline"
                type="button"
              >
                <BookmarkX size={10} />
              </button>
            )}
            <button
              aria-label="Download GPU benchmark JSON"
              onClick={() => downloadBenchmark(benchmark)}
              title="Download machine-readable benchmark JSON"
              type="button"
            >
              <Download size={10} />
            </button>
          </div>
          {benchmark.scenarios.map((scenario) => (
            <div className="benchmark-scenario" key={scenario.name}>
              <span>{scenario.name}</span>
              <strong>{scenario.gpuMs.median.toFixed(2)} ms</strong>
              <small>p95 {scenario.gpuMs.p95.toFixed(2)}</small>
              {comparison?.gpuMedianDeltaPercent[scenario.name] !== undefined && (
                <em className={regressionClass(comparison.gpuMedianDeltaPercent[scenario.name])}>
                  {formatDelta(comparison.gpuMedianDeltaPercent[scenario.name])}
                </em>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function formatDelta(percent: number): string {
  return `${percent > 0 ? "+" : ""}${percent.toFixed(1)}%`;
}

function regressionClass(percent: number): string {
  if (percent > 5) return "regressed";
  if (percent < -5) return "improved";
  return "stable";
}

function formatShadowMap(size?: number): string {
  return size && size > 1 ? `${size}²` : "off";
}

function PassTiming({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <span>{label}</span>
      <strong>{value.toFixed(2)} ms</strong>
    </div>
  );
}

function downloadBenchmark(report: GpuBenchmarkReport): void {
  const blob = new Blob([JSON.stringify(report, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `aster-gpu-benchmark-${report.generatedAt.replace(/:/g, "-")}.json`;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function Metric({
  icon: Icon,
  label,
  value,
  accent = false,
}: {
  icon: typeof Activity;
  label: string;
  value: string;
  accent?: boolean;
}) {
  return (
    <div className="metric-row">
      <Icon size={11} />
      <span>{label}</span>
      <strong className={accent ? "accent" : ""}>{value}</strong>
    </div>
  );
}
