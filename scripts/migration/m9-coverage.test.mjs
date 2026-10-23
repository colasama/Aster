import assert from "node:assert/strict";
import test from "node:test";
import { assertEvaluationCoverage, assertExportCoverage } from "./m9-coverage.mjs";

function fixture() {
  const corpus = { cases: [{ id: "case", frames: [0, 7] }] };
  const samples = [
    ...corpus.cases[0].frames.map((frame) => ({ kind: "frame", frame })),
    ...Array.from({ length: 64 }, (_, index) => ({ kind: "random", time: index / 13 })),
  ];
  const assignments = [{ case: corpus.cases[0], planSamples: { random_count: 64, samples } }];
  const plans = {
    kind: "native-project-corpus",
    status: "passed",
    full_coverage: true,
    source_unchanged: true,
    required_cases: 1,
    required_samples: samples.length,
    cases: [
      {
        id: "case",
        status: "passed",
        render: { status: "passed", exit_code: 0, command: ["cli", "render-project"] },
        samples: samples.map((sample) => ({
          sample,
          equal: true,
          step: { status: "passed", exit_code: 0, command: ["cli", "plan-diff"] },
        })),
      },
    ],
  };
  const frames = [0, 7].map((frame) => ({
    case_id: "case",
    frame,
    status: "passed",
    self_review_required: true,
    self_review: { verdict: "passed" },
  }));
  const pixels = {
    status: "passed",
    scope: "full",
    full_coverage: true,
    source_unchanged: true,
    inputs_unchanged: true,
    required_count: 2,
    frames,
    comparisons: structuredClone(frames),
  };
  const review = {
    status: "passed",
    frames: ["native", "ts"].flatMap((arm) =>
      [0, 7].map((frame) => ({ arm, frame, reviewed: true, status: "passed" })),
    ),
  };
  const exports = {
    kind: "native-project-export",
    status: "passed",
    full_coverage: true,
    native_export_acceptance: true,
    source_unchanged: true,
    required: ["case"],
    selected: ["case"],
    cases: [
      {
        id: "case",
        status: "passed",
        authenticated: true,
        review,
        result: {
          id: "case",
          status: "passed",
          frames: [0, 7],
          review,
          audio: { passed: true },
          quality: { passed: true },
        },
      },
    ],
    lifecycle: {
      status: "passed",
      source_unchanged: true,
      controls: [
        "cancel",
        "cancel-owner-audio",
        "existing-output-preserved",
        "pause-resume",
        "witness-budget-abort-preserves-no-output",
      ].map((kind) => ({ kind })),
    },
  };
  return { corpus, assignments, plans, pixels, exports };
}

test("exit coverage rejects omitted schedules, supplied plans and missing pixel reviews", () => {
  const check = (f) => assertEvaluationCoverage(f.corpus, f.assignments, f.plans, f.pixels);
  assert.deepEqual(check(fixture()), { cases: 1, samples: 66, pixel_frames: 2 });
  for (const attack of [
    (f) => f.plans.cases.pop(),
    (f) => f.plans.cases.push(f.plans.cases[0]),
    (f) => f.assignments[0].planSamples.samples.pop(),
    (f) => f.plans.cases[0].render.command.push("--plan", "supplied.fpln"),
    (f) => {
      f.plans.cases[0].samples[0].equal = false;
    },
    (f) => f.pixels.comparisons.pop(),
    (f) => {
      f.pixels.frames[1] = f.pixels.frames[0];
    },
    (f) => {
      delete f.pixels.frames[0].self_review;
    },
  ]) {
    const f = fixture();
    attack(f);
    assert.throws(() => check(f));
  }
});

test("export coverage requires both arms, native acceptance, complete frames and lifecycle", () => {
  const check = (f) => assertExportCoverage(f.corpus, f.exports);
  assert.deepEqual(check(fixture()), { cases: 1, reviewed_native_frames: 2 });
  const extended = fixture();
  extended.exports.lifecycle.controls.push(
    { kind: "paused-cancel" },
    { kind: "png-failed-budget" },
  );
  assert.deepEqual(check(extended), { cases: 1, reviewed_native_frames: 2 });
  for (const attack of [
    (f) => {
      f.exports.status = "incomplete";
    },
    (f) => {
      f.exports.native_export_acceptance = false;
    },
    (f) => {
      f.exports.cases[0].authenticated = false;
    },
    (f) => f.exports.cases[0].result.frames.pop(),
    (f) => {
      f.exports.cases[0].result.audio.passed = false;
    },
    (f) => {
      f.exports.cases[0].result.quality.passed = false;
    },
    (f) => f.exports.cases[0].review.frames.pop(),
    (f) => {
      f.exports.cases[0].review.frames[0].status = "failed";
    },
    (f) => {
      f.exports.cases[0].review.frames[0].reviewed = false;
    },
    (f) => f.exports.lifecycle.controls.pop(),
    (f) => f.exports.lifecycle.controls.push(f.exports.lifecycle.controls[0]),
  ]) {
    const f = fixture();
    attack(f);
    assert.throws(() => check(f));
  }
});
