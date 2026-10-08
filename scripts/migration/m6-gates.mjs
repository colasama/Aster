import assert from "node:assert/strict";
import { validateCurrentStep } from "./m3-pixels.mjs";
import { coreCases } from "./native-core-scope.mjs";
import { nativeEffectCases, validateNativeEffectScope } from "./native-effect-scope.mjs";
import { nativeRasterCases } from "./native-raster-batch.mjs";
import { nativeSequenceCases } from "./native-sequence-gate.mjs";
import { nativeVideoCases } from "./native-video-gate.mjs";
import { staticCommands } from "./static-checks.mjs";

/** A media exit includes every earlier native pixel gate and the complete timed-media corpus. */
export function validateM6Gates(report, corpus) {
  return validateNativeMediaGates(report, corpus, {
    milestone: "M6",
    scope: "native-media-mixed-v1",
    additionalCases: [],
  });
}

export function validateNativeMediaGates(report, corpus, { milestone, scope, additionalCases }) {
  assert.equal(report.milestone, milestone);
  assert.equal(report.mode, "full");
  assert.deepEqual([...report.required_gates].sort(), ["G0", "G3"]);
  assert.deepEqual(report.gates.map((g) => g.id).sort(), ["G0", "G3"]);
  assert(report.gates.every((g) => g.status === "passed"));
  const g0 = report.gates.find((g) => g.id === "G0");
  assert.deepEqual(
    g0.steps.map((s) => s.id).sort(),
    staticCommands()
      .map((s) => s.id)
      .sort(),
  );
  for (const step of g0.steps) validateCurrentStep(step, report.started_at);
  const native = report.gates.find((g) => g.id === "G3");
  assert.equal(native.scope, scope);
  for (const key of ["full_coverage", "milestone_exit_eligible", "native_gpu_execution"])
    assert.equal(native[key], true);
  validateNativeEffectScope(corpus);
  const cases = [...coreCases, ...nativeEffectCases, ...nativeRasterCases, ...additionalCases];
  assert.deepEqual([...native.cases].sort(), [...cases].sort());
  const select = (ids) => ({
    cases: ids.map((id) => {
      const item = corpus.cases.find((c) => c.id === id);
      assert(item, `Missing corpus case ${id}`);
      return item;
    }),
  });
  const coverage = (group, selected) => {
    const expected = selected.cases.flatMap((c) => c.frames.map((f) => `${c.id}:${f}`));
    assert.deepEqual(group.frames.map((f) => `${f.case_id}:${f.frame}`).sort(), expected.sort());
    return expected.length;
  };
  const selected = select(cases),
    sequences = select(nativeSequenceCases),
    videos = select(nativeVideoCases);
  assert.equal(native.required_count, coverage(native, selected));
  for (const step of [
    native.build,
    native.image_cache,
    native.effect_batch.step,
    native.raster_batch.step,
  ])
    validateCurrentStep(step, report.started_at);
  for (const name of [
    "native_stills",
    "native_exr",
    "native_surface_post",
    "native_auxiliary_primary",
    "native_surface_frames",
    "native_layer_cache",
    "native_ssaa_effect_evaluation",
    "native_temporal_text",
    "native_temporal_frames",
    "native_motion_frames",
    "native_sequences",
    "native_videos",
    "native_media_frames",
  ])
    assert.equal(native[name]?.status, "passed", `Missing supplement ${name}`);
  assert.equal(native.native_layer_cache.exact, (native.required_count + 16) * 4);
  assert.equal(native.native_layer_cache.frames.length, native.native_layer_cache.exact);
  assert.equal(coverage(native.native_sequences, sequences), 12);
  assert.equal(coverage(native.native_videos, videos), 44);
  assert.deepEqual(
    corpus.cases
      .filter((c) => c.features.includes("layer:video"))
      .map((c) => c.id)
      .sort(),
    [...nativeVideoCases].sort(),
  );
  assert.equal(native.native_media_frames.frames.length, 6);
  assert.equal(native.native_videos.decode_cache.exact_comparisons, 148);
  return { native, selected, sequences, videos };
}
