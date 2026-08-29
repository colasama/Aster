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
import { reportUiError } from "../errors/report-ui-error";
import {
  type MessageDescriptor,
  messageDescriptor,
  type Translate,
  translateDescriptor,
} from "../i18n/core";
import { useI18n } from "../i18n/react";
import type { GpuBenchmarkReport, GpuBenchmarkRequest } from "../renderer/gpu-benchmark";
import {
  compareGpuBenchmarks,
  parseGpuBenchmarkBaseline,
} from "../renderer/gpu-benchmark-baseline";
import { useEditor } from "../state/editor-store";

const BENCHMARK_BASELINE_KEY = "aster.gpuBenchmarkBaseline.v1";
const BENCHMARK_ACCEPT_TIMEOUT_MS = 1_000;

export function Profiler() {
  const { state } = useEditor();
  const { t } = useI18n();
  const metrics = state.metrics;
  const [benchmark, setBenchmark] = useState<GpuBenchmarkReport>();
  const [baseline, setBaseline] = useState<GpuBenchmarkReport | undefined>(readBaseline);
  const [benchmarkProgress, setBenchmarkProgress] = useState<MessageDescriptor>();
  const comparison = useMemo(
    () => (benchmark && baseline ? compareGpuBenchmarks(benchmark, baseline) : undefined),
    [baseline, benchmark],
  );
  const runBenchmark = (sampleFrames: number) => {
    if (benchmarkProgress) return;
    setBenchmark(undefined);
    setBenchmarkProgress(messageDescriptor("profiler.preparing"));
    void requestGpuBenchmark(sampleFrames, (scenario, completed, total) =>
      setBenchmarkProgress(
        messageDescriptor("profiler.progress", {
          scenario,
          percent: Math.round((completed / total) * 100),
        }),
      ),
    )
      .then((report) => setBenchmark(report))
      .catch((error: unknown) =>
        reportUiError(t, "gpuBenchmark", error, {
          scope: { area: "application" },
          retry: () => runBenchmark(sampleFrames),
        }),
      )
      .finally(() => setBenchmarkProgress(undefined));
  };
  return (
    <div className={`profiler-overlay ${benchmark ? "benchmark-expanded" : ""}`}>
      <div className="profiler-title">
        <Activity size={12} /> {t("profiler.realtime")} <span>GPU</span>
        <button
          disabled={Boolean(benchmarkProgress)}
          onClick={() => runBenchmark(60)}
          title={t("profiler.quickHint")}
          type="button"
        >
          {t("profiler.quick")}
        </button>
        <button
          disabled={Boolean(benchmarkProgress)}
          onClick={() => runBenchmark(600)}
          title={t("profiler.fullHint")}
          type="button"
        >
          {t("profiler.full")}
        </button>
      </div>
      <Metric icon={Gauge} label={t("profiler.fps")} value={metrics.fps.toFixed(0)} accent />
      <Metric icon={Zap} label={t("profiler.frame")} value={`${metrics.frameMs.toFixed(2)} ms`} />
      <Metric
        icon={Zap}
        label={t("profiler.gpuExecution")}
        value={
          metrics.gpuMs === undefined ? t("profiler.warming") : `${metrics.gpuMs.toFixed(2)} ms`
        }
      />
      <Metric icon={Cpu} label={t("profiler.cpuSubmit")} value={`${metrics.cpuMs.toFixed(2)} ms`} />
      <Metric
        icon={MemoryStick}
        label={t("profiler.vram")}
        value={`${metrics.estimatedVramMb.toFixed(0)} / ${metrics.memoryBudgetMb?.toFixed(0) ?? t("common.auto")} MB`}
      />
      <Metric
        icon={MemoryStick}
        label={t("profiler.pressureShadow")}
        value={`${metrics.memoryPressure ?? t("profiler.pressure.normal")} / ${formatShadowMap(metrics.shadowMapSize, t)}`}
      />
      <Metric
        icon={Layers3}
        label={t("profiler.passesDirty")}
        value={`${metrics.passCount} / ${metrics.dirtyNodes}`}
      />
      <Metric
        icon={Layers3}
        label={t("profiler.transient")}
        value={t("profiler.transientValue", { count: metrics.transientTextureCount })}
      />
      <Metric
        icon={Layers3}
        label={t("profiler.effectFusion")}
        value={t("profiler.effectFusionValue", {
          effects: metrics.fusedEffectCount ?? 0,
          groups: metrics.fusionGroupCount ?? 0,
          barriers: metrics.fusionBarrierCount ?? 0,
        })}
      />
      <Metric
        icon={MemoryStick}
        label={t("profiler.temporalCache")}
        value={`${(metrics.temporalCacheMb ?? 0).toFixed(1)} / 32 MB`}
      />
      {metrics.passTimings && (
        <div className="pass-breakdown">
          <PassTiming label={t("profiler.compute")} value={metrics.passTimings.computeMs} />
          <PassTiming label={t("profiler.shadow")} value={metrics.passTimings.shadowMs} />
          <PassTiming label={t("profiler.scene")} value={metrics.passTimings.sceneMs} />
          <PassTiming label={t("profiler.post")} value={metrics.passTimings.postMs} />
        </div>
      )}
      <div className="cache-bar">
        <span style={{ width: `${metrics.cacheHitRate * 100}%` }} />
        <small>
          {t("profiler.nodeCache", { percent: Math.round(metrics.cacheHitRate * 100) })}
        </small>
      </div>
      {benchmarkProgress && (
        <div className="benchmark-progress">{translateDescriptor(t, benchmarkProgress)}</div>
      )}
      {benchmark && (
        <div className="benchmark-report">
          <div className="benchmark-report-title">
            <span>
              {t("profiler.report", { count: benchmark.sampleFrames })}
              {baseline &&
                ` · ${comparison?.compatible ? t("profiler.vsBaseline") : t("profiler.hardwareMismatch")}`}
            </span>
            <button
              aria-label={baseline ? t("profiler.baseline.replace") : t("profiler.baseline.save")}
              onClick={() => {
                writeBaseline(benchmark);
                setBaseline(benchmark);
              }}
              title={
                baseline ? t("profiler.baseline.replaceHint") : t("profiler.baseline.saveHint")
              }
              type="button"
            >
              <BookmarkPlus size={10} />
            </button>
            {baseline && (
              <button
                aria-label={t("profiler.baseline.clear")}
                onClick={() => {
                  clearBaseline();
                  setBaseline(undefined);
                }}
                title={t("profiler.baseline.clearHint")}
                type="button"
              >
                <BookmarkX size={10} />
              </button>
            )}
            <button
              aria-label={t("profiler.download")}
              onClick={() => downloadBenchmark(benchmark)}
              title={t("profiler.downloadHint")}
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

export function requestGpuBenchmark(
  sampleFrames: number,
  onProgress: GpuBenchmarkRequest["onProgress"],
  acceptTimeoutMs = BENCHMARK_ACCEPT_TIMEOUT_MS,
): Promise<GpuBenchmarkReport> {
  return new Promise<GpuBenchmarkReport>((resolve, reject) => {
    let accepted = false;
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeoutId);
      callback();
    };
    const timeoutId = window.setTimeout(() => {
      if (!accepted)
        finish(() => reject(new Error("No open composition viewer accepted the GPU benchmark.")));
    }, acceptTimeoutMs);
    window.dispatchEvent(
      new CustomEvent<GpuBenchmarkRequest>("aster:run-gpu-benchmark", {
        detail: {
          sampleFrames,
          onProgress,
          accept: () => {
            accepted = true;
            window.clearTimeout(timeoutId);
          },
          reject: (error) =>
            finish(() =>
              reject(error instanceof Error ? error : new Error("GPU benchmark failed.")),
            ),
          resolve: (report) => finish(() => resolve(report)),
        },
      }),
    );
  });
}

function formatDelta(percent: number): string {
  return `${percent > 0 ? "+" : ""}${percent.toFixed(1)}%`;
}

function regressionClass(percent: number): string {
  if (percent > 5) return "regressed";
  if (percent < -5) return "improved";
  return "stable";
}

function formatShadowMap(size: number | undefined, t: Translate): string {
  return size && size > 1 ? `${size}²` : t("profiler.shadowOff");
}

function readBaseline(): GpuBenchmarkReport | undefined {
  try {
    return parseGpuBenchmarkBaseline(window.localStorage.getItem(BENCHMARK_BASELINE_KEY));
  } catch {
    return undefined;
  }
}

function writeBaseline(report: GpuBenchmarkReport): void {
  try {
    window.localStorage.setItem(BENCHMARK_BASELINE_KEY, JSON.stringify(report));
  } catch {
    // Benchmarking remains usable when local storage is unavailable.
  }
}

function clearBaseline(): void {
  try {
    window.localStorage.removeItem(BENCHMARK_BASELINE_KEY);
  } catch {
    // An in-memory baseline can still be cleared in private contexts.
  }
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
