import assert from "node:assert/strict";
import test from "node:test";
import { encodedStructuralPolicy } from "./encoded-structural-policy.mjs";
import { fixture } from "./m0-exit-fixtures.mjs";
import { auditStructuralWitness, layeredFrameReview } from "./structural-witness-audit.mjs";

test("layered witnesses reject stale code, wrong case, changed references and wrong native executable", async (t) => {
  const f = await fixture(t);
  await f.json("proposal.json", {});
  await f.write("native.exe", "binary");
  const binary = { path: "native.exe", sha256: await f.hash("native.exe") };
  const policy = {
    kind: encodedStructuralPolicy,
    approved: true,
    scope: "G5-only",
    allowed_alternatives: ["ink_bounds", "unobservable_registration"],
    same_case_frame_source_required: true,
    measured_over_limit_shift_rejected: true,
    other_quality_limits_unchanged: true,
    preserve_original_failures: true,
    proposal: { path: "proposal.json", sha256: await f.hash("proposal.json") },
  };
  const ledger = { owner_overrides: { layered_structural_policy: policy } };
  const original = {
    kind: encodedStructuralPolicy,
    source_unchanged: true,
    execution_sha256: "a".repeat(64),
    case_id: "case",
    reference_binding: { repairs: "frozen" },
    binary,
  };
  const execution = {
    source: { execution_sha256: original.execution_sha256 },
    reference_binding: original.reference_binding,
    execution: { native_binary: binary.path, binaries: [binary] },
  };
  for (const mutate of [
    (w) => {
      w.execution_sha256 = "b".repeat(64);
    },
    (w) => {
      w.case_id = "other";
    },
    (w) => {
      w.reference_binding = { repairs: "other" };
    },
    (w) => {
      w.binary = { ...binary, sha256: "b".repeat(64) };
    },
  ]) {
    const witness = structuredClone(original);
    mutate(witness);
    await f.json("witness.json", witness);
    await assert.rejects(
      auditStructuralWitness(
        f.root,
        {
          id: "case",
          structural_witness: { path: "witness.json", sha256: await f.hash("witness.json") },
        },
        execution,
        ledger,
      ),
      { code: "ERR_ASSERTION" },
    );
  }
});

test("layered review cannot reuse a flat verdict, another witness, changed metrics or tampered images", async (t) => {
  const f = await fixture(t),
    raw = {
      comparison: { metrics: { exact: false }, checks: [{ id: "ink_bounds", passed: false }] },
    };
  await f.json("encoded.json", raw);
  await f.write("contact.png", "contact");
  await f.write("heat.png", "heat");
  const witness = { path: "witness.json", sha256: "a".repeat(64) },
    alternatives = ["ink_bounds"];
  const entry = {
    id: "case",
    frames: [30],
    comparisons: [{ name: "native", index: 0, report: "encoded.json" }],
  };
  const review = {
    ...raw.comparison,
    purpose: encodedStructuralPolicy,
    case_id: "case",
    frame: 30,
    profile: "yuv",
    verdict: "accepted",
    residual_class: "decoder-rounding",
    layered_evidence: { witness, alternatives },
    evidence: {
      report: "encoded.json",
      report_sha256: await f.hash("encoded.json"),
      contact_sheet: "contact.png",
      contact_sheet_sha256: await f.hash("contact.png"),
      heatmap: "heat.png",
      heatmap_sha256: await f.hash("heat.png"),
    },
  };
  const audit = (r) =>
    layeredFrameReview(f.reader(), { self_reviews: [r] }, entry, 30, raw, witness, alternatives);
  assert.equal((await audit(review)).status, "passed");
  for (const mutate of [
    (r) => {
      delete r.purpose;
    },
    (r) => {
      r.frame = 0;
    },
    (r) => {
      r.layered_evidence.witness.sha256 = "b".repeat(64);
    },
  ]) {
    const r = structuredClone(review);
    mutate(r);
    assert.equal((await audit(r)).status, "awaiting-self-review");
  }
  for (const mutate of [
    (r) => {
      r.metrics.exact = true;
    },
    (r) => {
      r.layered_evidence.alternatives = [];
    },
  ]) {
    const r = structuredClone(review);
    mutate(r);
    await assert.rejects(audit(r));
  }
  assert.equal((await audit({ ...review, verdict: "rejected" })).status, "failed");
  await f.write("heat.png", "changed");
  await assert.rejects(audit(review), /SHA-256/);
});
