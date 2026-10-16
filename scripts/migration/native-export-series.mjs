import assert from "node:assert/strict";
import { distribution } from "../performance/statistics.mjs";

export const nativeExportWorkloads = [
  "owner-opening",
  "owner-main",
  "composite-1080p",
  "composite-4k",
  "effect-chain-1080p",
];

/** Four measured pairs balance first/second order after an excluded ten-frame warm-up pair. */
export function nativeExportSchedule(manifest, { paired = false, profile = false } = {}) {
  assert(!(paired && profile), "Sampling cannot participate in paired acceptance");
  const start = manifest.startFrame,
    end = manifest.endFrameExclusive;
  assert(Number.isSafeInteger(start) && Number.isSafeInteger(end) && start >= 0 && end > start);
  if (!paired)
    return (profile ? ["rust"] : ["rust", "ts"]).map((renderer) => ({
      id: `owner-${renderer}`,
      renderer,
      run: 1,
      warmup: false,
      start_frame: start,
      end_frame_exclusive: end,
    }));
  return [0, 1, 2, 3, 4].flatMap((run) =>
    (run % 2 ? ["ts", "rust"] : ["rust", "ts"]).map((renderer) => ({
      id: `paired-${run}-${renderer}`,
      renderer,
      run,
      warmup: run === 0,
      start_frame: start,
      end_frame_exclusive: run === 0 ? Math.min(start + 10, end) : end,
    })),
  );
}

/** Recompute from every observed frame and durable completion; never trust precomputed FPS. */
export function summarizeNativeExportSeries(jobs, manifest) {
  const schedule = nativeExportSchedule(manifest, { paired: true });
  assert.equal(jobs.length, schedule.length, "Incomplete paired export series");
  const input = new Set();
  const groups = { rust: [], ts: [] };
  const intervals = { rust: [], ts: [] };
  for (const [index, expected] of schedule.entries()) {
    const job = jobs[index];
    for (const key of ["id", "renderer", "run", "warmup", "start_frame", "end_frame_exclusive"])
      assert.deepEqual(job[key], expected[key], `Paired schedule differs at ${index}/${key}`);
    assert.equal(job.status, "completed");
    assert.equal(job.route?.renderer, expected.renderer, "A native run fell back to TS");
    assert.match(job.input_sha256, /^[a-f0-9]{64}$/);
    assert.match(job.sha256, /^[a-f0-9]{64}$/);
    input.add(job.input_sha256);
    const frames = expected.end_frame_exclusive - expected.start_frame;
    assert(Number.isFinite(job.elapsed_ms) && job.elapsed_ms > 0);
    assert.equal(job.progress.completedFrames, frames);
    assert.equal(job.frame_progress.length, frames, "Missing exact frame-completion observations");
    let previous = 0;
    const samples = job.frame_progress.map((sample, frame) => {
      assert.equal(sample.frames, frame + 1);
      assert(Number.isFinite(sample.elapsed_ms) && sample.elapsed_ms >= previous);
      assert(sample.elapsed_ms <= job.elapsed_ms);
      const interval = sample.elapsed_ms - previous;
      previous = sample.elapsed_ms;
      return interval;
    });
    const video = job.probe.streams.filter((s) => s.codec_type === "video");
    assert.equal(video.length, 1);
    assert.equal(video[0].codec_name, "h264");
    assert.equal(Number(video[0].nb_read_frames), frames);
    assert.equal(video[0].width, manifest.width);
    assert.equal(video[0].height, manifest.height);
    assert.equal(
      video[0].avg_frame_rate,
      `${manifest.frameRate.numerator}/${manifest.frameRate.denominator}`,
    );
    if (expected.warmup) continue;
    const fps = (frames * 1000) / job.elapsed_ms;
    assert.equal(job.fps, fps);
    groups[expected.renderer].push({ run: expected.run, elapsed_ms: job.elapsed_ms, fps });
    intervals[expected.renderer].push(...samples);
  }
  assert.equal(input.size, 1, "Inputs changed within the paired series");
  const result = Object.fromEntries(
    Object.entries(groups).map(([renderer, runs]) => [
      renderer,
      {
        runs,
        fps: distribution(runs.map((r) => r.fps)),
        elapsed_ms: distribution(runs.map((r) => r.elapsed_ms)),
        completion_interval_ms: distribution(intervals[renderer]),
      },
    ]),
  );
  return {
    ...result,
    higher_native_median_fps: result.rust.fps.median > result.ts.fps.median,
    quality_acceptance: "Requires independent G5 at the same bitrate and workload",
  };
}
