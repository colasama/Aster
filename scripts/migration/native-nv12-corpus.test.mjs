import assert from "node:assert/strict";
import test from "node:test";
import { nv12PlaneComparison } from "./native-nv12-case.mjs";
import { nv12CorpusCoverage } from "./native-nv12-corpus.mjs";
import { parseArguments } from "./verify.mjs";

test("NV12 planes reject truncation, swapped chroma, excess error and signed bias", () => {
  const size = { width: 4, height: 2 },
    reference = Buffer.from([16, 30, 40, 50, 60, 70, 80, 235, 90, 150, 100, 160]);
  assert(
    nv12PlaneComparison(reference, reference, size).every((p) => p.passed && p.peak_error === 0),
  );
  for (const at of [0, 8, 9]) {
    const candidate = Buffer.from(reference);
    candidate[at] += 2;
    assert(nv12PlaneComparison(reference, candidate, size).some((p) => !p.passed));
  }
  const biased = Buffer.from(reference);
  biased[8]++;
  biased[10]++;
  assert.equal(nv12PlaneComparison(reference, biased, size)[1].passed, false);
  const swapped = Buffer.from(reference);
  [swapped[8], swapped[9]] = [swapped[9], swapped[8]];
  assert.equal(nv12PlaneComparison(reference, swapped, size)[1].passed, false);
  assert.throws(() => nv12PlaneComparison(reference, reference.subarray(1), size));
  assert.throws(() => nv12PlaneComparison(reference, reference, { width: 3, height: 2 }));
});

test("partial, unreviewed, unauthenticated or failed conversion cases never pass full coverage", () => {
  const required = ["a", "b"],
    cases = required.map((id) => ({
      id,
      status: "passed",
      authenticated: true,
      checkpoint: { path: `${id}.json` },
    }));
  assert.deepEqual(nv12CorpusCoverage(required, cases), { status: "passed", full_coverage: true });
  assert.equal(nv12CorpusCoverage(required, cases.slice(0, 1)).status, "incomplete");
  for (const mutate of [
    (c) => {
      c.status = "incomplete";
    },
    (c) => {
      c.status = "failed";
    },
    (c) => {
      c.authenticated = false;
    },
    (c) => {
      delete c.checkpoint;
    },
  ]) {
    const bad = structuredClone(cases);
    mutate(bad[0]);
    assert.notEqual(nv12CorpusCoverage(required, bad).status, "passed");
  }
  assert.throws(() => nv12CorpusCoverage(required, [cases[0], cases[0]]));
  assert.throws(() => nv12CorpusCoverage(required, [{ ...cases[0], id: "extra" }]));
  assert.equal(
    parseArguments(["--milestone", "M8", "--nv12-resume", "report.json"]).nv12Resume,
    "report.json",
  );
  assert.throws(() => parseArguments(["--nv12-resume"]));
});
