import assert from "node:assert/strict";
import { validateProbe } from "../performance/output-session.mjs";
import { summarizePerformance } from "../performance/statistics.mjs";

/** Authenticate the retained arm without translating native receipts into TS-shaped evidence. */
export function retainedProjectMeasurements(report, raw, workloads, run, smoke) {
  assert.equal(raw.status, "passed");
  assert.equal(report.retained_runtime?.kind, "independently-retained-ts-runtime");
  assert.deepEqual(raw.retained_runtime, report.retained_runtime);
  assert.deepEqual(raw.host, report.host);
  assert.equal(report.assignments.length, workloads.length);
  assert.equal(raw.cases.length, workloads.length);
  summarizePerformance(raw.cases, report.assignments, true);
  return workloads.map((workload, index) => {
    const assignment = report.assignments[index],
      entry = raw.cases[index];
    const { result, output } = entry;
    const start = Math.min(...workload.frames),
      end = smoke
        ? Math.min(start + 10, Math.max(...workload.frames) + 1)
        : Math.max(...workload.frames) + 1;
    assert.equal(assignment.case.id, workload.case.id);
    assert.equal(assignment.caseHash, workload.caseHash);
    assert.deepEqual(assignment.inputs, workload.inputs);
    assert.equal(entry.case_hash, workload.caseHash);
    assert.deepEqual(entry.inputs, workload.inputs);
    assert.equal(entry.status, "passed");
    for (const [key, value] of Object.entries({
      run,
      mode: "full-mp4",
      warmupFrames: 10,
      startFrame: start,
      endFrameExclusive: end,
      frameRate: workload.frameRate,
    }))
      assert.deepEqual(assignment.benchmark[key], value);
    assert.equal(result.renderer, undefined);
    assert.equal(output.videoBitrateBps, 20_000_000);
    assert.equal(output.videoFrames, end - start);
    const audio = result.audio;
    if (workload.case.id.startsWith("owner-")) assert.equal(audio?.enabled, true);
    if (audio) {
      assert.equal(audio.enabled, true);
      assert.equal(audio.sampleRate, 48000);
      assert.equal(audio.channels, 2);
      assert.equal(
        audio.frameCount,
        Math.round(
          (((end - start) * workload.frameRate.denominator) / workload.frameRate.numerator) * 48000,
        ),
      );
    }
    assert.equal(output.audioFrames, audio?.frameCount ?? 0);
    validateProbe(output.ffprobe.result, {
      width: workload.case.size.width,
      height: workload.case.size.height,
      frameCount: end - start,
      frameRateNumerator: workload.frameRate.numerator,
      frameRateDenominator: workload.frameRate.denominator,
      ...(audio ? { audio } : {}),
    });
    assert.equal(typeof output.encoder, "string");
    assert(output.encoder.length > 0);
    return {
      run,
      frames: end - start,
      elapsed_ms: result.elapsedMs,
      fps: ((end - start) * 1000) / result.elapsedMs,
      intervals: result.frameCompletionIntervalsMs,
      audio_frames: output.audioFrames,
      encoder: output.encoder,
    };
  });
}
