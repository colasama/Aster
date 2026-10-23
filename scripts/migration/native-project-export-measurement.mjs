import assert from "node:assert/strict";

/** Reconstruct completed-frame timing from native receipts, never from a supplied FPS summary. */
export function nativeProjectMeasurement(rows, workload, { smoke = false } = {}) {
  const start = Math.min(...workload.frames),
    end = smoke
      ? Math.min(start + 10, Math.max(...workload.frames) + 1)
      : Math.max(...workload.frames) + 1,
    frames = end - start;
  const warmup = rows.filter((row) => row.stage === "warmup");
  assert.equal(warmup.length, 10, "Ten completed same-session warm-up frames are required");
  assert.deepEqual(rows.slice(0, 10), warmup);
  assert.equal(rows.length, frames + 14, "Unexpected or missing native timing events");
  assert.deepEqual(
    rows.slice(10, 13).map((row) => row.stage),
    ["audio", "encoder", "render"],
  );
  for (const row of rows.slice(10, 13)) {
    assert.equal(row.rendered_frames, 0);
    assert.equal(row.total_frames, frames);
  }
  let previous = 0;
  for (const [index, row] of warmup.entries()) {
    assert.equal(row.rendered_frames, index + 1);
    assert.equal(row.total_frames, 10);
    assert(Number.isSafeInteger(row.elapsed_ms) && row.elapsed_ms >= previous);
    previous = row.elapsed_ms;
  }
  const audio = rows.find((row) => row.stage === "audio");
  assert(audio && rows.indexOf(audio) > rows.indexOf(warmup.at(-1)));
  assert.equal(audio.rendered_frames, 0);
  assert.equal(audio.total_frames, frames);
  const receipt = rows.at(-1);
  assert.equal(receipt.status, "passed");
  assert.equal(receipt.project.authored_sha256, workload.inputs.project_sha256);
  assert.deepEqual(receipt.video.size, workload.case.size);
  assert.deepEqual(receipt.video.frame_rate, workload.frameRate);
  assert.equal(receipt.video.bitrate_bps, 20_000_000);
  assert.equal(receipt.report.frames, frames);
  assert.equal(receipt.report.encoder.accepted_frames, frames);
  assert.equal(receipt.report.encoder.encoded_frames, frames);
  assert.equal(receipt.report.encoder.drain_completed, true);
  assert(!receipt.witness, "Pixel readback diagnostics cannot participate in timed exports");
  assert(Number.isSafeInteger(receipt.report.elapsed_ms) && receipt.report.elapsed_ms > 0);
  if (workload.case.id.startsWith("owner-")) assert(receipt.report.audio_frames > 0);
  const progress = rows.filter((row) => row.stage === "render" && row.rendered_frames > 0);
  assert.equal(progress.length, frames);
  previous = 0;
  const intervals = progress.map((row, index) => {
    assert.equal(row.rendered_frames, index + 1);
    assert.equal(row.total_frames, frames);
    assert(Number.isSafeInteger(row.elapsed_ms) && row.elapsed_ms >= previous);
    assert(row.elapsed_ms <= receipt.report.elapsed_ms);
    const elapsed = row.elapsed_ms - previous;
    previous = row.elapsed_ms;
    return elapsed;
  });
  return {
    case_id: workload.case.id,
    start_frame: start,
    end_frame_exclusive: end,
    frames,
    warmup_frames: 10,
    warmup_ms: warmup.at(-1).elapsed_ms,
    elapsed_ms: receipt.report.elapsed_ms,
    fps: (frames * 1000) / receipt.report.elapsed_ms,
    completion_intervals_ms: intervals,
    audio_frames: receipt.report.audio_frames,
    adapter: receipt.adapter,
    transport: receipt.report.transport,
  };
}
