import assert from "node:assert/strict";
import test from "node:test";
import { CorpusCheckpointAudit } from "./native-project-corpus-evidence.mjs";
import { parseArguments } from "./verify.mjs";

test("corpus resume rejects supplied plans, partial coverage and contradictory process acceptance", () => {
  const report = {
    id: "G2",
    kind: "native-project-corpus",
    status: "passed",
    full_coverage: true,
    source_unchanged: true,
    source: { source_sha256: "a".repeat(64), execution_sha256: "b".repeat(64) },
    source_after: { source_sha256: "a".repeat(64) },
    required_cases: 1,
    required_samples: 2,
    cases: [{ id: "case", status: "passed", samples: [{ equal: true }, { equal: true }] }],
  };
  CorpusCheckpointAudit.assertComplete(report);
  for (const mutate of [
    (r) => {
      r.kind = "ts-plan-reference";
    },
    (r) => {
      r.full_coverage = false;
    },
    (r) => {
      r.source_unchanged = false;
    },
    (r) => {
      r.source_after.source_sha256 = "c".repeat(64);
    },
    (r) => {
      r.source.source_sha256 = undefined;
      r.source_after.source_sha256 = undefined;
    },
    (r) => {
      r.cases = [];
    },
    (r) => {
      r.cases.push(r.cases[0]);
      r.required_cases = 2;
      r.required_samples = 4;
    },
    (r) => {
      r.cases[0].samples.pop();
    },
    (r) => {
      r.cases[0].samples[0].equal = false;
    },
    (r) => {
      r.cases[0].samples[0].equal = "true";
    },
    (r) => {
      r.cases[0].status = "failed";
    },
  ]) {
    const changed = structuredClone(report);
    mutate(changed);
    assert.throws(() => CorpusCheckpointAudit.assertComplete(changed));
  }
});

test("native corpus resume is explicit and requires an argument", () => {
  assert.equal(
    parseArguments(["--project-corpus-resume", "saved.json"]).projectCorpusResume,
    "saved.json",
  );
  assert.throws(() => parseArguments(["--project-corpus-resume"]));
});
