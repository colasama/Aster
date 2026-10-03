import assert from "node:assert/strict";
import { test } from "node:test";
import { outputModes, scheduleWorkloads } from "./workloads.mjs";

test("owner boundaries remain immutable across three rotated output runs", () => {
  const workloads = [
    {
      case: { id: "owner-opening", frames: [0, 713] },
      frames: Array.from({ length: 714 }, (_, i) => i),
    },
    {
      case: { id: "owner-main", frames: [714, 1013] },
      frames: Array.from({ length: 300 }, (_, i) => i + 714),
    },
  ];
  const assignments = scheduleWorkloads(workloads);
  assert.equal(assignments.length, 24);
  assert.equal(new Set(assignments.map((item) => item.benchmark.id)).size, 24);
  for (const item of assignments) {
    const { run, startFrame, endFrameExclusive, mode } = item.benchmark;
    assert.ok(outputModes.includes(mode));
    assert.equal(startFrame, item.case.id === "owner-main" ? 714 : 0);
    assert.equal(
      endFrameExclusive,
      run === 0 ? startFrame + 10 : item.case.id === "owner-main" ? 1014 : 714,
    );
  }
  assert.deepEqual(
    assignments.slice(0, 6).map((item) => item.benchmark.run),
    Array(6).fill(0),
  );
  assert.equal(scheduleWorkloads(workloads, { smoke: true }).length, 6);
  assert.throws(() => scheduleWorkloads(workloads, { selected: ["absent"] }));
  assert.throws(() => scheduleWorkloads(workloads, { modes: ["imaginary"] }));
});
