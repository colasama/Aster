import assert from "node:assert/strict";
import test from "node:test";
import { assertRepairIndependence, auditReferenceRepairs } from "./m0-reference-repairs.mjs";
import { repairFixture } from "./m0-reference-repairs-fixtures.mjs";

const audit = (f) =>
  auditReferenceRepairs(f.reader(), f.ledger, f.corpus, f.original.frames, f.catalogHash);

test("reviewed repair replaces only one requested frame and preserves the original and neighbors", async (t) => {
  const f = await repairFixture(t);
  const result = await audit(f);
  assert.equal(result.repairs.length, 1);
  assert.equal(result.effective.size, 3);
  assert.notEqual(
    result.effective.get("sequence/1").rgba_sha256,
    f.original.frames.get("sequence/1").rgba_sha256,
  );
  for (const frame of [0, 2])
    assert.strictEqual(
      result.effective.get(`sequence/${frame}`),
      f.original.frames.get(`sequence/${frame}`),
    );
  assert.equal(f.original.frames.get("sequence/1").path, "refs/sequence/1/frame.png");
  const candidate = {
    manifest: { run_id: "independent-run" },
    requested: new Map([["sequence/1", { path: "independent/frame.png" }]]),
  };
  await f.write("independent/frame.png", (await f.reader().bytes(result.repairs[0].path)).bytes);
  await assertRepairIndependence(f.reader(), candidate, result.repairs);
  candidate.manifest.run_id = "repair-run";
  await assert.rejects(
    assertRepairIndependence(f.reader(), candidate, result.repairs),
    /repair capture run/,
  );
  candidate.manifest.run_id = "independent-run";
  candidate.requested.get("sequence/1").path = result.repairs[0].path;
  await assert.rejects(assertRepairIndependence(f.reader(), candidate, result.repairs), /itself/);
});

test("repair audit rejects unknown, duplicate, auxiliary, unreviewed and rejected substitutions", async (t) => {
  const f = await repairFixture(t);
  const valid = structuredClone(f.ledger);
  for (const mutate of [
    (ledger) => {
      ledger.reference_repairs[0].case_id = "unknown";
    },
    (ledger) => {
      ledger.reference_repairs.push(ledger.reference_repairs[0]);
    },
    (ledger) => {
      ledger.reference_repairs[0].frame = 0;
    },
    (ledger) => {
      ledger.reference_repairs[0].directory = "../unsafe";
    },
    (ledger) => {
      ledger.reference_repairs[0].renderer_source_sha256 = "f".repeat(64);
    },
    (ledger) => {
      ledger.self_reviews = [];
    },
    (ledger) => {
      ledger.self_reviews[0].verdict = "rejected";
    },
  ]) {
    f.ledger = structuredClone(valid);
    mutate(f.ledger);
    await assert.rejects(audit(f));
  }
});

test("repair audit rejects incomplete checks, changed limits, and stale bound evidence", async (t) => {
  const f = await repairFixture(t);
  const original = structuredClone(f.report);
  for (const mutate of [
    (report) => {
      report.comparison.checks.pop();
    },
    (report) => {
      report.comparison.profile.limits.max_abs_channel_error = 8;
    },
    (report) => {
      report.comparison.structural.largest_error_component = 65;
    },
    (report) => {
      report.previous.png_sha256 = "f".repeat(64);
    },
  ]) {
    const report = structuredClone(original);
    mutate(report);
    await f.json("review/report.json", report);
    const review = f.ledger.self_reviews[0];
    review.evidence.report_sha256 = await f.hash("review/report.json");
    for (const field of ["metrics", "ssim", "structural", "registration", "sequence"])
      review[field] = report.comparison[field];
    await assert.rejects(audit(f));
  }
  await f.json("review/report.json", original);
  await assert.rejects(audit(f), /SHA-256/);
});
