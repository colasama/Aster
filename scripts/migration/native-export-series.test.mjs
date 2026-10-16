import assert from "node:assert/strict";
import test from "node:test";
import { nativeExportSchedule, summarizeNativeExportSeries } from "./native-export-series.mjs";

const manifest = {
  startFrame: 714,
  endFrameExclusive: 1014,
  width: 1920,
  height: 1080,
  frameRate: { numerator: 30, denominator: 1 },
};
function observations() {
  return nativeExportSchedule(manifest, { paired: true }).map((item) => {
    const frames = item.end_frame_exclusive - item.start_frame;
    const elapsed = item.warmup
      ? 999999
      : item.renderer === "rust"
        ? 4000 + item.run
        : 8000 + item.run;
    return {
      ...item,
      status: "completed",
      input_sha256: "a".repeat(64),
      sha256: "b".repeat(64),
      route: { renderer: item.renderer },
      progress: { completedFrames: frames },
      elapsed_ms: elapsed,
      fps: (frames * 1000) / elapsed,
      frame_progress: Array.from({ length: frames }, (_, index) => ({
        frames: index + 1,
        elapsed_ms: ((index + 1) * elapsed) / frames,
      })),
      probe: {
        streams: [
          {
            codec_type: "video",
            codec_name: "h264",
            width: 1920,
            height: 1080,
            nb_read_frames: String(frames),
            avg_frame_rate: "30/1",
          },
        ],
      },
    };
  });
}

test("native series excludes warm-up and balances renderer order across four complete pairs", () => {
  const jobs = observations();
  assert.deepEqual(
    jobs.map((j) => `${j.run}/${j.renderer}`),
    ["0/rust", "0/ts", "1/ts", "1/rust", "2/rust", "2/ts", "3/ts", "3/rust", "4/rust", "4/ts"],
  );
  const report = summarizeNativeExportSeries(jobs, manifest);
  assert.equal(report.rust.elapsed_ms.median, 4002.5);
  assert.equal(report.ts.elapsed_ms.median, 8002.5);
  assert.equal(report.rust.completion_interval_ms.count, 1200);
  assert.equal(report.higher_native_median_fps, true);
  assert.equal(report.rust.fps.count, 4);
  assert.throws(() => nativeExportSchedule(manifest, { paired: true, profile: true }));
});

test("native series rejects missing pairs, fallback, input drift and invented timing/decoded output", () => {
  for (const mutate of [
    (jobs) => jobs.pop(),
    (jobs) => {
      jobs[3].route.renderer = "ts";
    },
    (jobs) => {
      jobs[3].input_sha256 = "c".repeat(64);
    },
    (jobs) => {
      jobs[3].fps *= 2;
    },
    (jobs) => {
      jobs[3].frame_progress.pop();
    },
    (jobs) => {
      jobs[3].frame_progress[5].frames++;
    },
    (jobs) => {
      jobs[3].frame_progress[5].elapsed_ms = NaN;
    },
    (jobs) => {
      jobs[3].probe.streams[0].nb_read_frames = "299";
    },
    (jobs) => {
      jobs[3].probe.streams[0].width = 640;
    },
    (jobs) => {
      jobs[3].probe.streams[0].avg_frame_rate = "60/1";
    },
    (jobs) => {
      [jobs[2], jobs[3]] = [jobs[3], jobs[2]];
    },
  ]) {
    const jobs = observations();
    mutate(jobs);
    assert.throws(() => summarizeNativeExportSeries(jobs, manifest));
  }
  const jobs = observations();
  for (const job of jobs.filter((j) => j.renderer === "rust")) {
    job.elapsed_ms *= 3;
    job.fps = (job.progress.completedFrames * 1000) / job.elapsed_ms;
    job.frame_progress.forEach((sample) => {
      sample.elapsed_ms *= 3;
    });
  }
  assert.equal(summarizeNativeExportSeries(jobs, manifest).higher_native_median_fps, false);
});
