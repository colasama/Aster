import assert from "node:assert/strict";
import { stableSource, validSha } from "./m0-evidence.mjs";
import { validateCurrentStep } from "./m3-pixels.mjs";
import { coreCases } from "./native-core-scope.mjs";
import { nativeEffectCases, validateNativeEffectScope } from "./native-effect-scope.mjs";
import { nativeRasterCases } from "./native-raster-batch.mjs";
import { staticCommands } from "./static-checks.mjs";

/** Exit coverage is derived from the current corpus, never from a caller's summary count. */
export function validateM5Gates(report, corpus) {
  assert.equal(report.milestone, "M5");
  assert.equal(report.mode, "full");
  assert.deepEqual([...report.required_gates].sort(), ["G0", "G1", "G3"]);
  assert.deepEqual(report.gates.map((g) => g.id).sort(), ["G0", "G1", "G3"]);
  assert(report.gates.every((g) => g.status === "passed"));
  const [g0, ir, native] = ["G0", "G1", "G3"].map((id) => report.gates.find((g) => g.id === id));
  assert.deepEqual(
    g0.steps.map((s) => s.id).sort(),
    staticCommands()
      .map((s) => s.id)
      .sort(),
  );
  for (const step of g0.steps) validateCurrentStep(step, report.started_at);
  assert.equal(ir.source_unchanged, true);
  stableSource(ir.source, ir.source_after, "source_sha256");
  assert.equal(ir.source.source_sha256, validSha(report.source.source_sha256));
  assert.equal(ir.binary.sha256, validSha(native.binary.sha256));
  assert.equal(ir.renderer_plan_complete, true);
  assert.equal(ir.raster_pixels.status, "passed");
  assert.equal(ir.raster_pixels.resources, 3);
  for (const field of [
    "exact_pixels",
    "exact_bounds",
    "dependency_eviction",
    "corrupt_pixels_rejected",
    "conflicting_generation_rejected",
    "scope_checked",
  ])
    assert.equal(ir.raster_pixels[field], true);
  assert.deepEqual(ir.resources.checks, [
    "descriptor_content_hash",
    "wrong_hash",
    "input_ownership",
    "idempotent_put",
    "budget_atomicity",
    "atomic_pin",
    "pinned_eviction",
    "missing_resource",
  ]);
  for (const [name, ids, fields] of [
    [
      "temporal_samples",
      ["full", "transparent", "exact-bits", "enters", "exits"].map((s) => `temporal-${s}`),
      ["exact_samples", "exact_weights", "exact_exposure", "formats_preserved"],
    ],
    [
      "temporal_passes",
      ["full", "partial", "transparent", "exact-bits"].map((s) => `temporal-pass-${s}`),
      ["exact_weights", "ordered_hashes_exact", "supplied_execution"],
    ],
  ]) {
    assert.deepEqual(
      ir[name].map((r) => r.id),
      ids,
    );
    for (const r of ir[name]) for (const field of fields) assert.equal(r[field], true);
  }
  const temporal = ir.frame_bundles.find((b) => b.id === "frame-bundle-temporal");
  assert(temporal && temporal.temporal_passes === 2 && temporal.media_pixels === 4);
  for (const field of [
    "exact_payloads",
    "exact_dependencies",
    "missing_rejected",
    "corrupt_rejected",
    "rust_count_rejected",
  ])
    assert.equal(temporal[field], true);
  validateNativeEffectScope(corpus);
  const cases = [...coreCases, ...nativeEffectCases, ...nativeRasterCases];
  assert.equal(new Set(cases).size, cases.length);
  assert.equal(native.scope, "native-rasters-v1");
  assert.equal(native.full_coverage, true);
  assert.equal(native.milestone_exit_eligible, true);
  assert.equal(native.native_gpu_execution, true);
  assert.deepEqual([...native.cases].sort(), [...cases].sort());
  const selected = cases.map((id) => {
    const c = corpus.cases.find((c) => c.id === id);
    assert(c);
    return c;
  });
  const required = selected.flatMap((c) => c.frames.map((f) => `${c.id}:${f}`));
  assert.equal(native.required_count, required.length);
  assert.deepEqual(native.frames.map((f) => `${f.case_id}:${f.frame}`).sort(), required.sort());
  for (const name of ["effect_batch", "raster_batch"]) {
    const ids = name === "effect_batch" ? nativeEffectCases : nativeRasterCases;
    const count = native.frames.filter((f) => ids.includes(f.case_id)).length;
    assert.equal(native[name].frames, count);
    assert.equal(native[name].device_reuses, count - 1);
    validateCurrentStep(native[name].step, report.started_at);
  }
  for (const step of [native.build, native.image_cache])
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
  ])
    assert.equal(native[name]?.status, "passed", `Missing supplement ${name}`);
  assert.equal(native.native_layer_cache.required_count, required.length + 16);
  assert.equal(native.native_layer_cache.exact, (required.length + 16) * 4);
  assert.equal(native.native_layer_cache.frames.length, native.native_layer_cache.exact);
  assert.equal(native.native_temporal_text.frames.length, 4);
  assert.equal(native.native_temporal_frames.frames.length, 2);
  assert.equal(native.native_motion_frames.frames.length, 6);
  assert.equal(native.native_surface_frames.required_count, 16);
  assert.equal(native.native_surface_frames.frames.length, 16);
  assert.equal(native.native_ssaa_effect_evaluation.strategy_enabled, false);
  assert.equal(native.native_ssaa_effect_evaluation.decision, "rejected");
  return { ir, native, selected: { cases: selected } };
}
