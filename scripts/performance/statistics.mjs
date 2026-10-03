import assert from "node:assert/strict";

/** Linear interpolation (R-7), matching the renderer's existing benchmark reports. */
export function distribution(samples) {
  assert.ok(Array.isArray(samples) && samples.length > 0, "Timing samples cannot be empty");
  assert.ok(
    samples.every((value) => Number.isFinite(value) && value >= 0),
    "Invalid timing sample",
  );
  const values = [...samples].sort((left, right) => left - right);
  const percentile = (quantile) => {
    const index = quantile * (values.length - 1);
    const low = Math.floor(index);
    const high = Math.ceil(index);
    return values[low] + (values[high] - values[low]) * (index - low);
  };
  return {
    count: values.length,
    minimum: values[0],
    median: percentile(0.5),
    p95: percentile(0.95),
    p99: percentile(0.99),
    maximum: values.at(-1),
  };
}

export function summarizePerformance(cases, assignments, diagnostic) {
  assert.equal(cases.length, assignments.length, "A benchmark assignment did not complete");
  const byId = new Map(assignments.map((item) => [item.benchmark.id, item]));
  const groups = new Map();
  const seen = new Set();
  for (const entry of cases) {
    const result = entry.result ?? entry;
    const assignment = byId.get(result.id);
    assert.ok(assignment && !seen.has(result.id), "Unknown or duplicate benchmark result");
    seen.add(result.id);
    assert.ok(!entry.status || entry.status === "passed", `Benchmark ${result.id} did not pass`);
    const expected = assignment.benchmark;
    for (const field of ["mode", "run", "startFrame", "endFrameExclusive", "warmupFrames"])
      assert.equal(result[field], expected[field], `Benchmark ${result.id} ${field} drift`);
    assert.deepEqual(result.frameRate, expected.frameRate);
    assert.equal(result.caseId, assignment.case.id);
    assert.equal(result.width, assignment.case.size.width);
    assert.equal(result.height, assignment.case.size.height);
    assert.equal(result.frames, expected.endFrameExclusive - expected.startFrame);
    assert.ok(Number.isFinite(result.elapsedMs) && result.elapsedMs > 0);
    assert.ok(Math.abs(result.framesPerSecond - (result.frames * 1000) / result.elapsedMs) < 1e-8);
    assert.equal(result.frameCompletionIntervalsMs.length, result.frames);
    assert.equal(result.readbackWallLatenciesMs.length, result.frames);
    const frameCompletion = distribution(result.frameCompletionIntervalsMs);
    const readback = distribution(result.readbackWallLatenciesMs);
    const completedDuration = result.frameCompletionIntervalsMs.reduce(
      (sum, value) => sum + value,
      0,
    );
    assert.ok(
      completedDuration <= result.elapsedMs + 0.001,
      "Completion intervals exceed total time",
    );
    if (result.run === 0) continue;
    const key = `${result.caseId}/${result.mode}`;
    const group = groups.get(key) ?? {
      case_id: result.caseId,
      mode: result.mode,
      frames_per_run: result.frames,
      frame_range: [result.startFrame, result.endFrameExclusive],
      size: { width: result.width, height: result.height },
      frame_rate: result.frameRate,
      runs: [],
      raw: { completion: [], readback: [] },
    };
    assert.equal(group.frames_per_run, result.frames);
    group.runs.push({
      id: result.id,
      run: result.run,
      elapsed_ms: result.elapsedMs,
      fps: result.framesPerSecond,
      completion_interval_ms: frameCompletion,
      readback_wall_ms: readback,
      encoder: entry.output?.encoder ?? entry.encoder ?? null,
      audio: result.audio,
    });
    group.raw.completion.push(...result.frameCompletionIntervalsMs);
    group.raw.readback.push(...result.readbackWallLatenciesMs);
    groups.set(key, group);
  }
  return [...groups.values()].map(({ raw, ...group }) => {
    if (!diagnostic) {
      assert.deepEqual(group.runs.map((run) => run.run).sort(), [1, 2, 3]);
      assert.ok(raw.completion.length >= 600, "Baseline needs at least 600 measured frames");
    }
    return {
      ...group,
      fps: distribution(group.runs.map((run) => run.fps)),
      elapsed_ms: distribution(group.runs.map((run) => run.elapsed_ms)),
      completion_interval_ms: distribution(raw.completion),
      readback_wall_ms: distribution(raw.readback),
      tracked_metrics: ["fps.median", "completion_interval_ms.median"],
    };
  });
}
