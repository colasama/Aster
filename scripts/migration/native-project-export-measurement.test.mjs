import assert from "node:assert/strict";
import test from "node:test";
import { nativeProjectMeasurement } from "./native-project-export-measurement.mjs";

test("project measurements require complete warm-up, ordered work, matching input and durable output receipts", () => {
  const workload = {
    case: { id: "owner-main", size: { width: 320, height: 180 } },
    frames: [17, 18],
    frameRate: { numerator: 30, denominator: 1 },
    inputs: { project_sha256: "a".repeat(64) },
  };
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
      total_frames: 2,
      elapsed_ms: 0,
    })),
    { stage: "render", rendered_frames: 1, total_frames: 2, elapsed_ms: 15 },
    { stage: "render", rendered_frames: 2, total_frames: 2, elapsed_ms: 25 },
    {
      status: "passed",
      project: { authored_sha256: workload.inputs.project_sha256 },
      video: { size: workload.case.size, frame_rate: workload.frameRate, bitrate_bps: 20000000 },
      report: {
        frames: 2,
        elapsed_ms: 40,
        audio_frames: 3200,
        transport: "nv12-shared",
        encoder: { accepted_frames: 2, encoded_frames: 2, drain_completed: true },
      },
      adapter: { name: "GPU" },
    },
  ];
  const measurement = nativeProjectMeasurement(rows, workload);
  assert.equal(measurement.fps, 50);
  assert.deepEqual(measurement.completion_intervals_ms, [15, 10]);
  for (const corrupt of [
    (r) => r.splice(0, 1),
    (r) => (r[1].rendered_frames = 1),
    (r) => (r[9].total_frames = 9),
    (r) => (r[10].stage = "paused"),
    (r) => (r[14].rendered_frames = 1),
    (r) => (r[14].elapsed_ms = 14),
    (r) => (r.at(-1).report.elapsed_ms = 0),
    (r) => (r.at(-1).report.elapsed_ms = 24),
    (r) => (r.at(-1).report.encoder.drain_completed = false),
    (r) => (r.at(-1).report.audio_frames = 0),
    (r) => (r.at(-1).project.authored_sha256 = "b".repeat(64)),
    (r) => (r.at(-1).video.size.width = 640),
    (r) => (r.at(-1).witness = { path: "extra-readback.json" }),
  ]) {
    const invalid = structuredClone(rows);
    corrupt(invalid);
    assert.throws(() => nativeProjectMeasurement(invalid, workload));
  }
});
