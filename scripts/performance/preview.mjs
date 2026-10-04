import assert from "node:assert/strict";
import { distribution } from "./statistics.mjs";

export const previewMethod = Object.freeze({
  version: 1,
  scope:
    "Production GPUCanvasContext present through GPUQueue.onSubmittedWorkDone; not display scan-out, playback or UI latency",
  scheduling:
    "Unpaced serial present, playing=false, no selection, no preview cache, no readback or output IPC",
  warmup: "Complete ten-frame suite (run 0) plus ten present/completion frames before each run",
  samples:
    "Three measured runs of 600 rationally addressed frames for each of three synthetic scenes",
  statistics: "R-7 frame latency distributions; separate distribution of three run throughputs",
  interval:
    "First measured present through final GPU completion; setup, warm-up and result IPC excluded",
  gpu_time: {
    status: "unavailable",
    reason: "Production asynchronous GPU timestamp samples are not independently frame-associated",
  },
});

/** Preview has no output transport; accepting any write would invalidate this measurement arm. */
export class PreviewOutputSession {
  report = { mode: "preview-present", outputCalls: 0 };
  output() {
    this.report.outputCalls++;
    throw new Error("Preview must not invoke output IPC");
  }
  async verify() {
    assert.equal(this.report.outputCalls, 0, "Preview invoked output IPC");
    return this.report;
  }
  async cancel() {}
}

export function validatePreviewResult(assignment, result, output, adapter) {
  const { benchmark, case: item } = assignment;
  const frames = benchmark.endFrameExclusive - benchmark.startFrame;
  assert.equal(benchmark.mode, "preview-present");
  assert.equal(result?.schemaVersion, 1);
  for (const field of ["id", "mode", "run", "startFrame", "endFrameExclusive", "warmupFrames"])
    assert.equal(result[field], benchmark[field], `Preview ${field} differs from assignment`);
  assert.equal(result.benchmarkId, benchmark.id);
  assert.equal(result.caseId, item.id);
  assert.equal(result.frames, frames);
  assert.equal(result.width, item.size.width);
  assert.equal(result.height, item.size.height);
  assert.deepEqual(result.frameRate, benchmark.frameRate);
  assert.equal(result.maxInFlight, 1);
  assert.equal(result.playing, false);
  assert(["bgra", "rgba"].includes(result.pixelFormat));
  assert.deepEqual(output, { mode: "preview-present", outputCalls: 0 });
  for (const forbidden of ["readbackWallLatenciesMs", "outputInvokeLatenciesMs", "audio", "gpuMs"])
    assert.equal(
      result[forbidden],
      undefined,
      "Preview cannot claim readback/encoding/GPU timestamp samples",
    );
  assert(Number.isFinite(result.elapsedMs) && result.elapsedMs > 0);
  assert(Number.isFinite(result.framesPerSecond) && result.framesPerSecond > 0);
  assert(
    Math.abs(result.framesPerSecond - (frames * 1000) / result.elapsedMs) < 1e-8,
    "Preview throughput disagrees with elapsed time",
  );
  for (const field of ["loadMs", "initializeMs"])
    assert(Number.isFinite(result[field]) && result[field] >= 0);
  assert(
    Array.isArray(result.samples) && result.samples.length === frames,
    "Missing preview samples",
  );
  let total = 0;
  for (const [index, sample] of result.samples.entries()) {
    assert.equal(
      sample.frame,
      benchmark.startFrame + index,
      "Preview samples are missing or out of order",
    );
    assert(Number.isFinite(sample.presentCallMs) && sample.presentCallMs >= 0);
    assert(
      Number.isFinite(sample.presentCompletionMs) &&
        sample.presentCompletionMs >= sample.presentCallMs,
    );
    total += sample.presentCompletionMs;
  }
  assert(total <= result.elapsedMs + 0.001, "Preview samples exceed measured duration");
  const diagnostics = result.diagnostics;
  assert.equal(diagnostics?.available, true);
  assert.equal(
    diagnostics.description,
    `${adapter.vendor || "GPU"} · ${adapter.description || adapter.device || "WebGPU"}`,
  );
  for (const field of [
    "materialResourceError",
    "adjustmentLayerError",
    "precompositionSurfaceError",
    "sceneGeneratorError",
  ])
    assert(!diagnostics[field], `Preview renderer error: ${field}`);
}

export function summarizePreview(cases, assignments, diagnostic = false) {
  assert.equal(cases.length, assignments.length, "Incomplete preview assignments");
  const expected = new Map(assignments.map((entry) => [entry.benchmark.id, entry]));
  assert.equal(expected.size, assignments.length);
  const groups = new Map();
  for (const entry of cases) {
    const result = entry.result;
    const assignment = expected.get(result.id);
    assert(assignment, "Unknown or duplicate preview result");
    expected.delete(result.id);
    assert.equal(entry.status, "passed");
    for (const field of ["id", "mode", "run", "startFrame", "endFrameExclusive", "warmupFrames"])
      assert.equal(result[field], assignment.benchmark[field]);
    assert.equal(result.caseId, assignment.case.id);
    if (result.run === 0) continue;
    const group = groups.get(result.caseId) ?? {
      case_id: result.caseId,
      mode: "preview-present",
      frames_per_run: result.frames,
      frame_range: [result.startFrame, result.endFrameExclusive],
      size: { width: result.width, height: result.height },
      frame_rate: result.frameRate,
      runs: [],
      raw: [],
    };
    assert.equal(group.frames_per_run, result.frames);
    group.runs.push({
      id: result.id,
      run: result.run,
      elapsed_ms: result.elapsedMs,
      fps: result.framesPerSecond,
    });
    group.raw.push(...result.samples);
    groups.set(result.caseId, group);
  }
  assert.equal(expected.size, 0);
  return [...groups.values()].map(({ raw, ...group }) => {
    if (!diagnostic) {
      assert.deepEqual(group.runs.map((run) => run.run).sort(), [1, 2, 3]);
      assert.equal(group.frames_per_run, 600);
      assert.equal(raw.length, 1800);
    }
    return {
      ...group,
      fps: distribution(group.runs.map((run) => run.fps)),
      elapsed_ms: distribution(group.runs.map((run) => run.elapsed_ms)),
      present_call_ms: distribution(raw.map((sample) => sample.presentCallMs)),
      present_completion_ms: distribution(raw.map((sample) => sample.presentCompletionMs)),
      tracked_metrics: ["fps.median", "present_completion_ms.median"],
    };
  });
}
