import assert from "node:assert/strict";
import test from "node:test";
import { assertM11PixelCoverage } from "./m11-exit.mjs";

function fixture() {
  const corpus = { cases: [{ id: "owner-main", frames: [1, 2] }] };
  const evidence = { report: "review.json" };
  const frames = corpus.cases[0].frames.map((frame) => ({
    case_id: "owner-main",
    frame,
    profile: frame === 1 ? "gpu" : "exact",
    status: "passed",
    step: { status: "passed" },
    self_review_required: frame === 1,
    self_review: frame === 1 ? evidence : undefined,
  }));
  const gate = {
    full_coverage: true,
    native_preview_acceptance: true,
    corpus: {
      full_coverage: true,
      native_preview_acceptance: true,
      cases: structuredClone(corpus.cases),
      pixels: { status: "passed", full_coverage: true, required_count: 2, frames },
    },
  };
  const ledger = {
    self_reviews: [
      {
        case_id: "owner-main",
        frame: 1,
        verdict: "accepted",
        residual_class: "float-precision",
        evidence,
      },
    ],
  };
  return { corpus, gate, ledger };
}
test("preview coverage requires every authored address and its admitted self-review", () => {
  const f = fixture();
  assert.equal(assertM11PixelCoverage(f.corpus, f.gate, f.ledger), 2);
  for (const mutate of [
    (f) => f.gate.corpus.pixels.frames.pop(),
    (f) => {
      f.gate.corpus.pixels.frames[1] = f.gate.corpus.pixels.frames[0];
    },
    (f) => {
      f.gate.corpus.cases[0].frames = [1];
    },
    (f) => {
      f.gate.corpus.pixels.required_count = 1;
    },
    (f) => {
      f.gate.corpus.full_coverage = false;
    },
    (f) => {
      f.ledger.self_reviews[0].verdict = "rejected";
    },
    (f) => {
      f.ledger.self_reviews[0].residual_class = "structural";
    },
    (f) => {
      f.ledger.self_reviews = [];
    },
  ]) {
    const value = fixture();
    mutate(value);
    assert.throws(() => assertM11PixelCoverage(value.corpus, value.gate, value.ledger));
  }
});
