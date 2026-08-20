import { Activity, Cpu, Gauge, Layers3, MemoryStick, Zap } from "lucide-react";
import { useEditor } from "../state/editor-store";

export function Profiler() {
  const { state } = useEditor();
  const metrics = state.metrics;
  return (
    <div className="profiler-overlay">
      <div className="profiler-title">
        <Activity size={12} /> REALTIME <span>GPU</span>
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
        value={`${metrics.estimatedVramMb.toFixed(0)} MB`}
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
          <PassTiming label="Scene" value={metrics.passTimings.sceneMs} />
          <PassTiming label="Post / ACES" value={metrics.passTimings.postMs} />
        </div>
      )}
      <div className="cache-bar">
        <span style={{ width: `${metrics.cacheHitRate * 100}%` }} />
        <small>Node cache {Math.round(metrics.cacheHitRate * 100)}%</small>
      </div>
    </div>
  );
}

function PassTiming({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <span>{label}</span>
      <strong>{value.toFixed(2)} ms</strong>
    </div>
  );
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
