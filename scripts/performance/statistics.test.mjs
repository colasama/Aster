import assert from "node:assert/strict";
import { test } from "node:test";
import { distribution, summarizePerformance } from "./statistics.mjs";

test("timing summaries use R-7 quantiles and never turn missing samples into zero", () => {
  assert.deepEqual(distribution([40, 10, 30, 20]), {
    count: 4,
    minimum: 10,
    median: 25,
    p95: 38.5,
    p99: 39.699999999999996,
    maximum: 40,
  });
  for (const values of [[], [NaN], [Infinity], [-1]]) assert.throws(() => distribution(values));
});

test("baseline summaries require real complete results from all three runs", () => {
  const assignments = [1, 2, 3].map((run) => ({
    case: { id: "owner-main", size: { width: 1920, height: 1080 } },
    benchmark: {
      id: `run-${run}`,
      mode: "readback-only",
      run,
      warmupFrames: 10,
      startFrame: 714,
      endFrameExclusive: 1014,
      frameRate: { numerator: 30, denominator: 1 },
    },
  }));
  const cases = assignments.map(({ benchmark }) => ({
    ...benchmark,
    schemaVersion: 1,
    caseId: "owner-main",
    width: 1920,
    height: 1080,
    frames: 300,
    elapsedMs: 3000,
    framesPerSecond: 100,
    frameCompletionIntervalsMs: Array(300).fill(9),
    readbackWallLatenciesMs: Array(300).fill(8),
    audio: null,
  }));
  const result = summarizePerformance(cases, assignments, false);
  assert.equal(result[0].completion_interval_ms.count, 900);
  assert.equal(result[0].fps.median, 100);
  assert.throws(() => summarizePerformance(cases.slice(0, 1), assignments, false));
  assert.throws(() => summarizePerformance(cases.slice(0, 1), assignments.slice(0, 1), false));
  assert.throws(() => summarizePerformance([cases[0], cases[0], cases[2]], assignments, false));
  const bad = structuredClone(cases);
  bad[0].frameCompletionIntervalsMs.pop();
  assert.throws(() => summarizePerformance(bad, assignments, false));
});
