import assert from "node:assert/strict";

// Coverage assertions only. File authenticity and source binding belong to the exit reader.
export function assertEvaluationCoverage(corpus, assignments, plans, pixels) {
  const ids = corpus.cases.map((item) => item.id);
  assert(ids.length > 0 && new Set(ids).size === ids.length);
  assert.deepEqual(
    assignments.map((item) => item.case),
    corpus.cases,
  );
  assert.equal(plans.kind, "native-project-corpus");
  assert.equal(plans.status, "passed");
  assert.equal(plans.full_coverage, true);
  assert.equal(plans.source_unchanged, true);
  assert.deepEqual(
    plans.cases.map((item) => item.id),
    ids,
  );
  assert.equal(plans.required_cases, ids.length);
  let count = 0;
  for (const [index, entry] of plans.cases.entries()) {
    const assignment = assignments[index];
    assert(!assignment.unavailable);
    const schedule = assignment.planSamples;
    assert.equal(schedule.random_count, 64);
    assert.equal(schedule.samples.filter((sample) => sample.kind === "random").length, 64);
    assert.equal(entry.status, "passed");
    assert.equal(entry.render.status, "passed");
    assert.equal(entry.render.exit_code, 0);
    assert.equal(entry.render.command[1], "render-project");
    for (const forbidden of ["--plan", "--batch", "--resources"])
      assert(!entry.render.command.includes(forbidden));
    assert.deepEqual(
      entry.samples.map((sample) => sample.sample),
      schedule.samples,
    );
    for (const sample of entry.samples) {
      assert.equal(sample.equal, true);
      assert.equal(sample.step.status, "passed");
      assert.equal(sample.step.exit_code, 0);
      assert.equal(sample.step.command[1], "plan-diff");
    }
    count += schedule.samples.length;
  }
  assert.equal(plans.required_samples, count);
  const expectedFrames = corpus.cases
    .flatMap((item) => item.frames.map((frame) => JSON.stringify([item.id, frame])))
    .sort();
  assert.equal(new Set(expectedFrames).size, expectedFrames.length);
  assert.equal(pixels.status, "passed");
  assert.equal(pixels.scope, "full");
  assert.equal(pixels.full_coverage, true);
  assert.equal(pixels.source_unchanged, true);
  assert.equal(pixels.inputs_unchanged, true);
  assert.equal(pixels.required_count, expectedFrames.length);
  for (const group of [pixels.frames, pixels.comparisons])
    assert.deepEqual(
      group.map((frame) => JSON.stringify([frame.case_id, frame.frame])).sort(),
      expectedFrames,
    );
  assert(
    pixels.frames.every(
      (frame) => frame.status === "passed" && (!frame.self_review_required || frame.self_review),
    ),
  );
  return { cases: ids.length, samples: count, pixel_frames: expectedFrames.length };
}

export function assertExportCoverage(corpus, exports) {
  const ids = corpus.cases.map((item) => item.id);
  assert(ids.length > 0 && new Set(ids).size === ids.length);
  assert.equal(exports.kind, "native-project-export");
  assert.equal(exports.status, "passed");
  assert.equal(exports.full_coverage, true);
  assert.equal(exports.native_export_acceptance, true);
  assert.equal(exports.source_unchanged, true);
  for (const actual of [exports.required, exports.selected, exports.cases.map((item) => item.id)])
    assert.deepEqual(actual, ids);
  let frames = 0;
  for (const [index, entry] of exports.cases.entries()) {
    const expected = corpus.cases[index].frames.toSorted((a, b) => a - b);
    assert.equal(entry.status, "passed");
    assert.equal(entry.authenticated, true);
    assert.equal(entry.result.id, entry.id);
    assert.equal(entry.result.status, "passed");
    assert.equal(entry.result.audio.passed, true);
    assert.equal(entry.result.quality.passed, true);
    assert.deepEqual(
      entry.result.frames.toSorted((a, b) => a - b),
      expected,
    );
    assert.equal(entry.review.status, "passed");
    assert.deepEqual(entry.result.review, entry.review);
    assert(
      entry.review.frames.every(
        (frame) => frame.reviewed && ["passed", "failed"].includes(frame.status),
      ),
    );
    for (const arm of ["native", "ts"]) {
      const reviews = entry.review.frames.filter((frame) => frame.arm === arm);
      assert.deepEqual(
        reviews.map((frame) => frame.frame).sort((a, b) => a - b),
        expected,
      );
      if (arm === "native") assert(reviews.every((frame) => frame.status === "passed"));
    }
    assert(entry.review.frames.every((frame) => ["native", "ts"].includes(frame.arm)));
    frames += expected.length;
  }
  assert.equal(exports.lifecycle.status, "passed");
  assert.equal(exports.lifecycle.source_unchanged, true);
  assert.deepEqual(
    exports.lifecycle.controls.map((control) => control.kind).sort(),
    [
      "cancel",
      "cancel-owner-audio",
      "existing-output-preserved",
      "pause-resume",
      "witness-budget-abort-preserves-no-output",
    ].sort(),
  );
  return { cases: ids.length, reviewed_native_frames: frames };
}
