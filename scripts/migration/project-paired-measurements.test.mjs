import assert from "node:assert/strict";
import test from "node:test";
import { pairedObservationSchedule } from "./native-paired-measurements.mjs";
import { nativeProjectMeasurement } from "./native-project-export-measurement.mjs";
import { summarizeProjectPairs } from "./project-paired-measurements.mjs";

function fixture(smoke = false) {
  const workload = {
    case: { id: "owner-main", size: { width: 2, height: 2 } },
    frames: [3, 22],
    frameRate: { numerator: 30, denominator: 1 },
    caseHash: "case-hash",
    inputs: { project_sha256: "a".repeat(64) },
  };
  const observations = pairedObservationSchedule(smoke).map(({ run, renderer }) => {
    const frames = smoke ? 10 : 20,
      end = 3 + frames,
      audioFrames = frames * 1600;
    const source = { source_sha256: "source" },
      hardware = { runConditions: { baselineEligible: true } };
    const host = { gpu_info: { gpuDevice: [{ active: true, vendorId: 1, deviceId: 2 }] } };
    const retained = { kind: "independently-retained-ts-runtime" };
    const probe = {
      bytes: 100,
      sha256: "output",
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
          {
            codec_type: "audio",
            codec_name: "aac",
            sample_rate: "48000",
            channels: 2,
            duration: String(frames / 30),
          },
        ],
        format: { duration: String(frames / 30) },
      },
    };
    const common = {
      status: "passed",
      smoke,
      source,
      source_after: source,
      hardware,
      hardware_after: hardware,
      workload_baseline: { sha256: "baseline" },
      binaries: { ffmpeg: { path: "ffmpeg.exe", sha256: "ffmpeg" } },
    };
    if (renderer === "ts") {
      const benchmark = {
        id: `ts-${run}`,
        mode: "full-mp4",
        run,
        warmupFrames: 10,
        startFrame: 3,
        endFrameExclusive: end,
        frameRate: workload.frameRate,
      };
      return {
        report: {
          ...common,
          renderer,
          host,
          retained_runtime: retained,
          assignments: [{ ...workload, benchmark }],
        },
        raw: {
          status: "passed",
          host,
          retained_runtime: retained,
          cases: [
            {
              status: "passed",
              inputs: workload.inputs,
              case_hash: workload.caseHash,
              result: {
                ...benchmark,
                caseId: workload.case.id,
                width: 2,
                height: 2,
                frames,
                elapsedMs: 200,
                framesPerSecond: frames * 5,
                frameCompletionIntervalsMs: Array(frames).fill(5),
                readbackWallLatenciesMs: Array(frames).fill(1),
                audio: { enabled: true, sampleRate: 48000, channels: 2, frameCount: audioFrames },
              },
              output: {
                encoder: "libx264",
                videoBitrateBps: 20000000,
                videoFrames: frames,
                audioFrames,
                ffprobe: probe,
              },
            },
          ],
        },
      };
    }
    const rows = [
      ...Array.from({ length: 10 }, (_, i) => ({
        stage: "warmup",
        rendered_frames: i + 1,
        total_frames: 10,
        elapsed_ms: i + 1,
      })),
      ...["audio", "encoder", "render"].map((stage) => ({
        stage,
        rendered_frames: 0,
        total_frames: frames,
        elapsed_ms: 0,
      })),
      ...Array.from({ length: frames }, (_, i) => ({
        stage: "render",
        rendered_frames: i + 1,
        total_frames: frames,
        elapsed_ms: i + 1,
      })),
      {
        status: "passed",
        project: { authored_sha256: workload.inputs.project_sha256 },
        adapter: { backend: "Dx12", vendor: 1, device: 2 },
        video: { size: workload.case.size, frame_rate: workload.frameRate, bitrate_bps: 20000000 },
        report: {
          frames,
          elapsed_ms: 100,
          audio_frames: audioFrames,
          output_bytes: 100,
          transport: "nv12-readback",
          encoder: {
            encoder_name: "hardware",
            accepted_frames: frames,
            encoded_frames: frames,
            drain_completed: true,
            cancelled: false,
          },
        },
      },
    ];
    return {
      report: {
        ...common,
        kind: "native-project-export-observation",
        raster_cache_bytes: 67108864,
        renderer: "rust-project",
        run,
        source_unchanged: true,
        execution_artifacts: { runtime: "native" },
        binaries: [{ path: "ffmpeg.exe", sha256: "ffmpeg" }],
        cases: [
          {
            id: workload.case.id,
            case_hash: workload.caseHash,
            inputs: workload.inputs,
            rows,
            receipt: rows.at(-1),
            measurement: nativeProjectMeasurement(rows, workload, { smoke }),
            output: { bytes: 100, sha256: "output" },
            probe,
          },
        ],
      },
    };
  });
  return structuredClone({ observations, workloads: [workload] });
}

test("independent project and retained protocols recompute balanced medians", () => {
  for (const smoke of [false, true]) {
    const { observations, workloads } = fixture(smoke);
    const [summary] = summarizeProjectPairs(observations, workloads, smoke);
    assert.equal(summary.higher_native_median_fps, true);
    assert.equal(summary.rust.fps.median, smoke ? 100 : 200);
    assert.equal(summary.ts.fps.median, smoke ? 50 : 100);
    assert.equal(summary.rust.fps.count, smoke ? 2 : 4);
    assert.equal(summary.rust.completion_interval_ms.count, smoke ? 20 : 80);
  }
});

test("project pairs reject reordered, incomplete and mismatched evidence", () => {
  const mutations = [
    (values) => values.pop(),
    (values) => values.reverse(),
    (values) => {
      values[1].report.renderer = "rust";
    },
    (values) => {
      values[1].report.run = 2;
    },
    (values) => {
      values[1].report.raster_cache_bytes = 0;
    },
    (values) => {
      values[1].report.source = { source_sha256: "changed" };
    },
    (values) => {
      values[1].report.hardware = { runConditions: { baselineEligible: false } };
    },
    (values) => {
      values[1].report.binaries[0].sha256 = "changed";
    },
    (values) => {
      values[1].report.execution_artifacts.runtime = "changed";
    },
    (values) => {
      values[0].report.host.gpu_info.gpuDevice[0].deviceId = 3;
    },
    (values) => {
      values[0].report.retained_runtime.kind = "candidate";
    },
    (values) => {
      values[0].raw.cases[0].result.elapsedMs = 1;
    },
    (values) => {
      values[0].raw.cases[0].result.audio.frameCount = 1;
    },
    (values) => {
      values[0].raw.cases[0].output.videoBitrateBps = 10000000;
    },
    (values) => {
      values[1].report.cases[0].measurement.fps = 99999;
    },
    (values) => {
      values[1].report.cases[0].rows.shift();
    },
    (values) => {
      values[1].report.cases[0].receipt.report.encoder.drain_completed = false;
    },
    (values) => {
      values[1].report.cases[0].receipt.report.encoder.cancelled = true;
    },
    (values) => {
      values[1].report.cases[0].case_hash = "wrong";
    },
    (values) => {
      values[1].report.cases[0].probe.result.streams[0].nb_read_frames = "1";
    },
    (values) => {
      values[1].report.cases[0].output.sha256 = "changed";
    },
  ];
  for (const mutate of mutations) {
    const { observations, workloads } = fixture();
    mutate(observations);
    assert.throws(() => summarizeProjectPairs(observations, workloads));
  }
});

test("equal native throughput cannot establish acceptance", () => {
  const { observations, workloads } = fixture();
  for (const { report } of observations) {
    if (report.renderer !== "rust-project") continue;
    const entry = report.cases[0];
    entry.receipt.report.elapsed_ms = 200;
    entry.measurement = nativeProjectMeasurement(entry.rows, workloads[0]);
  }
  assert.equal(summarizeProjectPairs(observations, workloads)[0].higher_native_median_fps, false);
});
