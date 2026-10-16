import assert from "node:assert/strict";
import test from "node:test";
import {
  pairedObservationSchedule,
  summarizePairedObservations,
} from "./native-paired-measurements.mjs";

function fixture(smoke = false) {
  const workload = {
    case: { id: "composite-1080p", size: { width: 2, height: 2 } },
    frames: [3, 22],
    caseHash: "inputs-hash",
    inputs: { revision: 1 },
    frameRate: { numerator: 30, denominator: 1 },
  };
  const source = { source_sha256: "source" };
  const hardware = { runConditions: { baselineEligible: true } };
  const host = { gpu_info: { gpuDevice: [{ active: true, vendorId: 1, deviceId: 2 }] } };
  const retained = { kind: "independently-retained-ts-runtime" };
  const observations = pairedObservationSchedule(smoke).map(({ run, renderer }) => {
    const end = smoke ? 13 : 23;
    const frames = end - 3;
    const elapsedMs = renderer === "rust" ? 100 : 200;
    const benchmark = {
      id: `sample-${run}-${renderer}`,
      run,
      mode: "full-mp4",
      warmupFrames: 10,
      startFrame: 3,
      endFrameExclusive: end,
    };
    const assignment = { ...workload, benchmark };
    const result = {
      ...benchmark,
      caseId: workload.case.id,
      frames,
      width: 2,
      height: 2,
      frameRate: workload.frameRate,
      elapsedMs,
      framesPerSecond: (frames * 1000) / elapsedMs,
      frameCompletionIntervalsMs: Array(frames).fill(elapsedMs / frames),
      audio: null,
      ...(renderer === "rust" ? { renderer } : {}),
    };
    const output = {
      videoBitrateBps: 20_000_000,
      videoFrames: frames,
      audioFrames: 0,
      ffprobe: {
        result: {
          streams: [
            {
              codec_type: "video",
              codec_name: "h264",
              width: 2,
              height: 2,
              nb_read_frames: String(frames),
              avg_frame_rate: "30/1",
              duration: String(frames / 30),
            },
          ],
          format: { duration: String(frames / 30) },
        },
      },
      ...(renderer === "rust"
        ? {
            renderer,
            admittedFrames: frames,
            transport: {
              warmup: { frames: 10 },
              nativeAdapter: { vendor: 1, device: 2, backend: "Dx12" },
              adapterLuid: { low: 1, high: 0 },
              probedAdapterLuid: { low: 1, high: 0 },
            },
            observedWorkMs: 99,
            encoderReport: {
              encoder: "h264_mf",
              nativeEncoder: { encoded_frames: frames, drain_completed: true },
            },
          }
        : { encoder: "libx264" }),
    };
    const report = {
      status: "passed",
      smoke,
      renderer,
      source,
      source_after: source,
      workload_baseline: { sha256: "baseline" },
      hardware,
      hardware_after: hardware,
      host,
      binaries: { ffmpeg: { sha256: "ffmpeg" } },
      assignments: [assignment],
      ...(renderer === "ts"
        ? { retained_runtime: retained }
        : { execution_artifacts: { runtime: "same-native-snapshot" } }),
    };
    const raw = {
      status: "passed",
      host,
      cases: [
        { status: "passed", case_hash: workload.caseHash, inputs: workload.inputs, result, output },
      ],
      ...(renderer === "ts" ? { retained_runtime: retained } : {}),
    };
    return { report, raw };
  });
  return { observations: structuredClone(observations), workloads: [workload] };
}

test("paired results recompute raw medians and percentiles with balanced order", () => {
  for (const smoke of [false, true]) {
    const { observations, workloads } = fixture(smoke);
    const [result] = summarizePairedObservations(observations, workloads, smoke);
    assert.equal(result.higher_native_median_fps, true);
    assert.equal(result.rust.fps.median, smoke ? 100 : 200);
    assert.equal(result.ts.fps.median, smoke ? 50 : 100);
    assert.equal(result.rust.fps.count, smoke ? 2 : 4);
    assert.equal(result.rust.completion_interval_ms.count, smoke ? 20 : 80);
    assert.equal(result.ts.elapsed_ms.p99, 200);
  }
});

test("paired evidence rejects incomplete, reordered, changed and biased observations", () => {
  const mutations = [
    (values) => values.pop(),
    (values) => values.reverse(),
    (values) => {
      values[0].report.retained_runtime.kind = "candidate-ts";
    },
    (values) => {
      values[1].report.source = { source_sha256: "changed" };
    },
    (values) => {
      values[1].report.binaries.ffmpeg.sha256 = "changed";
    },
    (values) => {
      values[1].report.hardware = { runConditions: { baselineEligible: false } };
    },
    (values) => {
      values[1].report.host = { gpu_info: { gpuDevice: [] } };
    },
    (values) => {
      values[2].report.execution_artifacts.runtime = "changed";
    },
    (values) => {
      values[1].raw.cases[0].result.elapsedMs = 1;
    },
    (values) => {
      values[1].raw.cases[0].output.observedWorkMs = 200;
    },
    (values) => {
      values[1].raw.cases[0].output.videoBitrateBps = 10_000_000;
    },
    (values) => {
      values[1].raw.cases[0].output.transport.warmup.frames = 0;
    },
    (values) => {
      values[1].raw.cases[0].result.frameCompletionIntervalsMs.pop();
    },
    (values) => {
      values[1].raw.cases[0].result.startFrame = 0;
    },
    (values) => {
      values[1].raw.cases[0].case_hash = "different-inputs";
    },
    (values) => {
      values[1].raw.cases[0].output.encoderReport.nativeEncoder.drain_completed = false;
    },
    (values) => {
      values[1].raw.cases[0].output.ffprobe.result.streams[0].nb_read_frames = "1";
    },
  ];
  for (const mutate of mutations) {
    const { observations, workloads } = fixture();
    mutate(observations);
    assert.throws(() => summarizePairedObservations(observations, workloads));
  }
});

test("paired acceptance rejects equal or lower native throughput", () => {
  const { observations, workloads } = fixture();
  for (const { raw, report } of observations) {
    if (report.renderer !== "rust") continue;
    const result = raw.cases[0].result;
    result.elapsedMs = 200;
    result.framesPerSecond = 100;
  }
  assert.equal(
    summarizePairedObservations(observations, workloads)[0].higher_native_median_fps,
    false,
  );
});
