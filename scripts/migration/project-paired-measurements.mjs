import assert from "node:assert/strict";
import { validateProbe } from "../performance/output-session.mjs";
import { distribution } from "../performance/statistics.mjs";
import { pairedObservationSchedule } from "./native-paired-measurements.mjs";
import { nativeProjectMeasurement } from "./native-project-export-measurement.mjs";
import { retainedProjectMeasurements } from "./project-paired-ts-measurement.mjs";

/** Compare independent raw protocols, binding hardware and workload identity across every pair. */
export function summarizeProjectPairs(observations, workloads, smoke = false) {
  const schedule = pairedObservationSchedule(smoke);
  assert.equal(observations.length, schedule.length);
  const groups = workloads.map(() => ({ ts: [], rust: [] }));
  let source, baseline, hardware, retained, active, artifacts, adapter, nativeBinaries;
  const binaries = new Map();
  const conditions = ({ capturedAt: _time, ...value }) => value;
  for (const [index, { report, raw }] of observations.entries()) {
    const expected = schedule[index],
      native = expected.renderer === "rust";
    assert.equal(report.status, "passed");
    assert.equal(report.renderer, native ? "rust-project" : "ts");
    assert.equal(report.smoke, smoke);
    source ??= report.source.source_sha256;
    assert.equal(report.source.source_sha256, source);
    assert.equal(report.source_after.source_sha256, source);
    baseline ??= report.workload_baseline;
    assert.deepEqual(report.workload_baseline, baseline);
    hardware ??= conditions(report.hardware);
    assert.equal(report.hardware.runConditions.baselineEligible, true);
    assert.deepEqual(conditions(report.hardware), hardware);
    assert.deepEqual(conditions(report.hardware_after), hardware);
    for (const file of Object.values(report.binaries)) {
      if (!binaries.has(file.path)) binaries.set(file.path, file.sha256);
      assert.equal(file.sha256, binaries.get(file.path));
    }
    if (!native) {
      retained ??= report.retained_runtime;
      assert.deepEqual(report.retained_runtime, retained);
      const gpu = report.host.gpu_info.gpuDevice.filter((device) => device.active);
      assert(gpu.length > 0);
      active ??= gpu;
      assert.deepEqual(gpu, active);
      const measured = retainedProjectMeasurements(report, raw, workloads, expected.run, smoke);
      for (const [i, item] of measured.entries()) groups[i].ts.push(item);
      continue;
    }
    assert.equal(report.kind, "native-project-export-observation");
    assert.equal(report.raster_cache_bytes, 67108864, "Production raster cache is required");
    assert.equal(report.run, expected.run);
    assert.equal(report.source_unchanged, true);
    assert(report.execution_artifacts);
    artifacts ??= report.execution_artifacts;
    assert.deepEqual(report.execution_artifacts, artifacts);
    nativeBinaries ??= report.binaries;
    assert.deepEqual(report.binaries, nativeBinaries);
    assert.equal(report.cases.length, workloads.length);
    for (const [i, workload] of workloads.entries()) {
      const entry = report.cases[i];
      assert.equal(entry.id, workload.case.id);
      assert.equal(entry.case_hash, workload.caseHash);
      assert.deepEqual(entry.inputs, workload.inputs);
      const measurement = nativeProjectMeasurement(entry.rows, workload, { smoke });
      assert.deepEqual(entry.measurement, measurement);
      assert.deepEqual(entry.receipt, entry.rows.at(-1));
      assert.equal(measurement.adapter.backend, "Dx12");
      adapter ??= measurement.adapter;
      assert.deepEqual(measurement.adapter, adapter);
      assert.equal(
        active.filter(
          (device) => device.vendorId === adapter.vendor && device.deviceId === adapter.device,
        ).length,
        1,
        "Native project GPU differs from the active retained TS GPU",
      );
      const audio = measurement.audio_frames > 0 ? { sampleRate: 48000, channels: 2 } : null;
      if (audio)
        assert.equal(
          measurement.audio_frames,
          Math.round(
            ((measurement.frames * workload.frameRate.denominator) / workload.frameRate.numerator) *
              48000,
          ),
        );
      validateProbe(entry.probe.result, {
        width: workload.case.size.width,
        height: workload.case.size.height,
        frameCount: measurement.frames,
        frameRateNumerator: workload.frameRate.numerator,
        frameRateDenominator: workload.frameRate.denominator,
        ...(audio ? { audio } : {}),
      });
      assert.equal(entry.output.sha256, entry.probe.sha256);
      assert.equal(entry.output.bytes, entry.probe.bytes);
      assert.equal(entry.receipt.report.output_bytes, entry.probe.bytes);
      assert.equal(entry.receipt.report.encoder.cancelled, false);
      assert(["nv12-readback", "nv12-shared"].includes(measurement.transport));
      const encoder = entry.receipt.report.encoder.encoder_name;
      assert(typeof encoder === "string" && encoder.length > 0);
      groups[i].rust.push({
        run: expected.run,
        frames: measurement.frames,
        elapsed_ms: measurement.elapsed_ms,
        fps: measurement.fps,
        intervals: measurement.completion_intervals_ms,
        audio_frames: measurement.audio_frames,
        encoder,
      });
    }
  }
  return groups.map((arms, index) => {
    const summarize = (runs) => {
      assert.deepEqual(
        runs.map((run) => run.run),
        smoke ? [1, 2] : [1, 2, 3, 4],
      );
      for (const run of runs) {
        assert.equal(run.audio_frames, arms.ts[0].audio_frames, "Paired audio workload differs");
        assert.equal(run.encoder, runs[0].encoder, "Encoder changed within an arm");
      }
      return {
        runs: runs.map(({ intervals: _intervals, ...run }) => run),
        fps: distribution(runs.map((run) => run.fps)),
        elapsed_ms: distribution(runs.map((run) => run.elapsed_ms)),
        completion_interval_ms: distribution(runs.flatMap((run) => run.intervals)),
      };
    };
    const ts = summarize(arms.ts),
      rust = summarize(arms.rust);
    return {
      id: workloads[index].case.id,
      ts,
      rust,
      higher_native_median_fps: rust.fps.median > ts.fps.median,
    };
  });
}
