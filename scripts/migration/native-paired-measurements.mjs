import assert from "node:assert/strict";
import { validateProbe } from "../performance/output-session.mjs";
import { distribution } from "../performance/statistics.mjs";

export function pairedObservationSchedule(smoke = false) {
  return Array.from({ length: smoke ? 2 : 4 }, (_, index) => index + 1).flatMap((run) =>
    (run % 2 ? ["ts", "rust"] : ["rust", "ts"]).map((renderer) => ({ run, renderer })),
  );
}

/** Recompute timings from raw, ordered observations; never accept an arm's summary fields. */
export function summarizePairedObservations(observations, workloads, smoke = false) {
  const schedule = pairedObservationSchedule(smoke);
  assert.equal(observations.length, schedule.length, "Incomplete paired observation series");
  const groups = new Map(workloads.map((item) => [item.case.id, { ts: [], rust: [] }]));
  let gpu, hardware, source, baseline, retained, nativeArtifacts, nativeAdapter, nativeLuid;
  const binaries = {};
  for (const [index, observation] of observations.entries()) {
    const expected = schedule[index];
    const { report, raw } = observation;
    assert.equal(report.status, "passed");
    assert.equal(raw.status, "passed");
    assert.equal(report.smoke, smoke);
    assert.equal(report.renderer, expected.renderer, "Paired renderer order changed");
    assert.equal(report.source.source_sha256, report.source_after.source_sha256);
    source ??= report.source.source_sha256;
    assert.equal(report.source.source_sha256, source, "Sources changed between paired runs");
    baseline ??= report.workload_baseline;
    assert.deepEqual(report.workload_baseline, baseline);
    const conditions = ({ capturedAt: _time, ...value }) => value;
    hardware ??= conditions(report.hardware);
    assert.equal(report.hardware.runConditions.baselineEligible, true);
    assert.deepEqual(conditions(report.hardware), hardware);
    assert.deepEqual(conditions(report.hardware_after), hardware);
    const active = report.host.gpu_info.gpuDevice.filter((device) => device.active);
    assert(active.length > 0, "No active GPU identity");
    gpu ??= active;
    assert.deepEqual(active, gpu, "Active GPU changed between paired runs");
    assert.deepEqual(raw.host, report.host);
    for (const [name, entry] of Object.entries(report.binaries)) {
      binaries[name] ??= entry.sha256;
      assert.equal(entry.sha256, binaries[name], "Execution binary changed between paired runs");
    }
    if (expected.renderer === "ts") {
      assert.equal(report.retained_runtime?.kind, "independently-retained-ts-runtime");
      retained ??= report.retained_runtime;
      assert.deepEqual(report.retained_runtime, retained);
      assert.deepEqual(raw.retained_runtime, retained);
    } else {
      assert(report.execution_artifacts, "Native execution artifacts are missing");
      nativeArtifacts ??= report.execution_artifacts;
      assert.deepEqual(
        report.execution_artifacts,
        nativeArtifacts,
        "Native runtime snapshot changed",
      );
    }
    assert.equal(report.assignments.length, workloads.length);
    assert.equal(raw.cases.length, workloads.length);
    for (const [caseIndex, workload] of workloads.entries()) {
      const assignment = report.assignments[caseIndex];
      const entry = raw.cases[caseIndex];
      const { result, output } = entry;
      const start = Math.min(...workload.frames);
      const end = smoke
        ? Math.min(start + 10, Math.max(...workload.frames) + 1)
        : Math.max(...workload.frames) + 1;
      const frames = end - start;
      assert.equal(assignment.case.id, workload.case.id);
      assert.equal(assignment.caseHash, workload.caseHash);
      assert.deepEqual(assignment.inputs, workload.inputs);
      assert.equal(entry.case_hash, workload.caseHash);
      assert.deepEqual(entry.inputs, workload.inputs);
      assert.equal(entry.status, "passed");
      assert.equal(assignment.benchmark.run, expected.run);
      assert.equal(assignment.benchmark.mode, "full-mp4");
      assert.equal(assignment.benchmark.warmupFrames, 10);
      assert.equal(assignment.benchmark.startFrame, start);
      assert.equal(assignment.benchmark.endFrameExclusive, end);
      for (const [key, value] of Object.entries({
        id: assignment.benchmark.id,
        caseId: workload.case.id,
        mode: "full-mp4",
        run: expected.run,
        startFrame: start,
        endFrameExclusive: end,
        frames,
        warmupFrames: 10,
        width: workload.case.size.width,
        height: workload.case.size.height,
        frameRate: workload.frameRate,
      }))
        assert.deepEqual(result[key], value, `Paired workload differs: ${key}`);
      assert(Number.isFinite(result.elapsedMs) && result.elapsedMs > 0);
      assert(Math.abs(result.framesPerSecond - (frames * 1000) / result.elapsedMs) < 1e-6);
      assert.equal(result.frameCompletionIntervalsMs.length, frames);
      distribution(result.frameCompletionIntervalsMs);
      assert(
        result.frameCompletionIntervalsMs.reduce((a, b) => a + b, 0) <= result.elapsedMs + 0.001,
      );
      assert.equal(output.videoBitrateBps, 20_000_000, "Paired bitrate differs");
      assert.equal(output.videoFrames, frames);
      const audio = result.audio;
      if (workload.case.id.startsWith("owner-")) assert.equal(audio?.enabled, true);
      if (audio) {
        assert.equal(audio.enabled, true);
        assert.equal(audio.sampleRate, 48000);
        assert.equal(audio.channels, 2);
        assert.equal(
          audio.frameCount,
          Math.round(
            ((frames * workload.frameRate.denominator) / workload.frameRate.numerator) * 48000,
          ),
        );
      }
      assert.equal(output.audioFrames, audio?.frameCount ?? 0);
      validateProbe(output.ffprobe.result, {
        width: result.width,
        height: result.height,
        frameCount: frames,
        frameRateNumerator: result.frameRate.numerator,
        frameRateDenominator: result.frameRate.denominator,
        ...(audio ? { audio } : {}),
      });
      if (expected.renderer === "rust") {
        const adapter = output.transport.nativeAdapter;
        assert(adapter && adapter.backend === "Dx12", "Native DX12 adapter identity is missing");
        assert.equal(
          gpu.filter(
            (device) => device.vendorId === adapter.vendor && device.deviceId === adapter.device,
          ).length,
          1,
          "Native GPU differs from active browser GPU",
        );
        assert.deepEqual(output.transport.adapterLuid, output.transport.probedAdapterLuid);
        const luid = output.transport.adapterLuid;
        assert(
          Number.isSafeInteger(luid?.low) && Number.isSafeInteger(luid?.high),
          "Native adapter LUID is missing",
        );
        nativeAdapter ??= adapter;
        nativeLuid ??= luid;
        assert.deepEqual(adapter, nativeAdapter);
        assert.deepEqual(luid, nativeLuid);
        assert.equal(result.renderer, "rust");
        assert.equal(output.renderer, "rust");
        assert.equal(output.admittedFrames, frames);
        assert.equal(output.transport.warmup.frames, 10);
        assert.equal(output.encoderReport.encoder, "h264_mf");
        assert.equal(output.encoderReport.nativeEncoder.encoded_frames, frames);
        assert.equal(output.encoderReport.nativeEncoder.drain_completed, true);
        assert(Number.isFinite(output.observedWorkMs) && output.observedWorkMs > 0);
        assert(
          result.elapsedMs + 1 >= output.observedWorkMs,
          "Native interval omitted actual work",
        );
      } else assert.equal(result.renderer, undefined, "Retained arm claimed a native renderer");
      groups.get(workload.case.id)[expected.renderer].push({
        run: expected.run,
        frames,
        elapsed_ms: result.elapsedMs,
        fps: (frames * 1000) / result.elapsedMs,
        intervals: result.frameCompletionIntervalsMs,
        audio,
        encoder: output.encoder ?? output.encoderReport.encoder,
      });
    }
  }
  return [...groups].map(([id, arms]) => {
    const summarize = (runs) => {
      assert.deepEqual(
        runs.map((run) => run.run),
        smoke ? [1, 2] : [1, 2, 3, 4],
      );
      for (const run of runs) {
        assert.deepEqual(run.audio, arms.ts[0].audio, "Paired audio workload differs");
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
    return { id, ts, rust, higher_native_median_fps: rust.fps.median > ts.fps.median };
  });
}
