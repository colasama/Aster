import assert from "node:assert/strict";
import test from "node:test";
import { auditProductionPixelReviews } from "./m12-project.mjs";

function fixture() {
  const comparison = {
    passed: true,
    profile: { name: "raster" },
    width: 16,
    height: 16,
    reference_rgba_sha256: "a".repeat(64),
    candidate_rgba_sha256: "b".repeat(64),
    metrics: { errors: 1 },
  };
  const evidence = { report: "current.json", report_sha256: "c".repeat(64) },
    accepted = { report: "accepted.json", report_sha256: "d".repeat(64) };
  const frame = {
    case_id: "text",
    frame: 0,
    status: "passed",
    profile: "raster",
    evidence,
    step: { status: "passed", exit_code: 0 },
    self_review_required: true,
    self_review: accepted,
  };
  const review = {
    case_id: "text",
    frame: 0,
    verdict: "accepted",
    residual_class: "sampling-order",
    evidence: accepted,
  };
  const raw = { context: { case_id: "text" }, comparison },
    documents = new Map([
      ["current.json", raw],
      ["accepted.json", structuredClone(raw)],
    ]);
  const gate = {
    evidence: [evidence],
    frames: [frame],
    comparisons: [{ case_id: "text", frame: 0, comparison, evidence }],
  };
  const reader = {
    async json(path, sha) {
      assert.equal(sha, path === "current.json" ? evidence.report_sha256 : accepted.report_sha256);
      assert(documents.has(path));
      return documents.get(path);
    },
  };
  return { gate, ledger: { self_reviews: [review] }, reader, documents };
}

test("M12 accepts an authenticated earlier self-review for identical current pixel results", async () => {
  const f = fixture();
  assert.deepEqual(await auditProductionPixelReviews(f.reader, f.gate, f.ledger), {
    status: "passed",
    frames: 1,
    reviewed: 1,
  });
});

test("M12 rejects missing reviews, structural residuals, mismatched frames and changed comparison evidence", async () => {
  for (const mutate of [
    (f) => {
      f.ledger.self_reviews = [];
    },
    (f) => {
      f.ledger.self_reviews[0].verdict = "rejected";
    },
    (f) => {
      f.ledger.self_reviews[0].residual_class = "structural";
    },
    (f) => {
      f.ledger.self_reviews[0].frame = 1;
    },
    (f) => {
      f.gate.frames[0].self_review_required = false;
    },
    (f) => {
      f.gate.frames[0].step.exit_code = 1;
    },
    (f) => {
      f.documents.get("accepted.json").comparison.candidate_rgba_sha256 = "e".repeat(64);
    },
    (f) => {
      f.documents.get("accepted.json").comparison.metrics.errors = 2;
    },
    (f) => {
      f.gate.comparisons[0].frame = 1;
    },
  ]) {
    const f = fixture();
    mutate(f);
    await assert.rejects(auditProductionPixelReviews(f.reader, f.gate, f.ledger));
  }
});
