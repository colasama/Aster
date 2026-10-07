import assert from "node:assert/strict";
import { posix } from "node:path";
import { M0Evidence } from "./m0-evidence.mjs";
import { auditNativePixels, validateCurrentStep } from "./m3-pixels.mjs";
import { auditM4Supplements } from "./m4-supplements.mjs";
import { coreCases, coreCorpus } from "./native-core-scope.mjs";
import { nativeEffectCases, validateNativeEffectScope } from "./native-effect-scope.mjs";
import { staticCommands } from "./static-checks.mjs";

export function validateM4Gates(report, corpus) {
  assert.equal(report.milestone, "M4");
  assert.equal(report.mode, "full");
  assert.deepEqual([...report.required_gates].sort(), ["G0", "G3"]);
  assert.deepEqual(report.gates.map((gate) => gate.id).sort(), ["G0", "G3"]);
  assert(report.gates.every((gate) => gate.status === "passed"));
  const g0 = report.gates.find((gate) => gate.id === "G0");
  assert.deepEqual(
    g0.steps.map((step) => step.id).sort(),
    staticCommands()
      .map((step) => step.id)
      .sort(),
  );
  for (const step of g0.steps) validateCurrentStep(step, report.started_at);
  validateNativeEffectScope(corpus);
  const selected = [
    ...coreCorpus(corpus).cases,
    ...corpus.cases.filter((c) => nativeEffectCases.includes(c.id)),
  ];
  const native = report.gates.find((gate) => gate.id === "G3");
  assert.equal(native.scope, "native-effects-fused-v4");
  assert.equal(native.full_coverage, true);
  assert.equal(native.milestone_exit_eligible, true);
  assert.equal(native.native_gpu_execution, true);
  assert.deepEqual([...native.cases].sort(), [...coreCases, ...nativeEffectCases].sort());
  const required = selected.flatMap((item) => item.frames.map((frame) => `${item.id}:${frame}`));
  assert.equal(native.required_count, required.length);
  assert.deepEqual(
    native.frames.map((frame) => `${frame.case_id}:${frame.frame}`).sort(),
    required.sort(),
  );
  const effects = native.frames.filter((frame) => nativeEffectCases.includes(frame.case_id));
  assert.equal(native.effect_batch.frames, effects.length);
  assert.equal(native.effect_batch.device_reuses, effects.length - 1);
  for (const step of [native.build, native.image_cache, native.effect_batch.step])
    validateCurrentStep(step, report.started_at);
  for (const name of [
    "native_stills",
    "native_exr",
    "native_surface_post",
    "native_auxiliary_primary",
    "native_surface_frames",
    "native_layer_cache",
    "native_ssaa_effect_evaluation",
  ])
    assert.equal(native[name]?.status, "passed", `Missing supplemental evidence: ${name}`);
  assert.equal(native.native_surface_post.frames.length, 2);
  assert.equal(native.native_surface_frames.required_count, 16);
  assert.equal(native.native_surface_frames.frames.length, 16);
  const cache = native.native_layer_cache;
  assert.equal(cache.required_count, required.length + 16);
  assert.equal(cache.exact, cache.required_count * 4);
  assert.equal(cache.frames.length, cache.exact);
  assert(cache.hits > 0 && cache.bounded_passes > 0 && cache.saved_pixels > 0);
  const ssaa = native.native_ssaa_effect_evaluation;
  assert.equal(ssaa.strategy_enabled, false);
  assert.equal(ssaa.decision, "rejected");
  assert.equal(ssaa.frames.length, 4);
  for (const frame of ssaa.frames) {
    assert.equal(frame.comparison.passed, false);
    assert(frame.comparison.metrics.max_abs_channel_error > 8);
  }
  return { native, selected: { cases: selected } };
}

/** Completing effects requires current native pixels and frozen input provenance, not summary flags. */
export async function auditM4Exit(root, report) {
  const reader = new M0Evidence(root);
  const ledger = await reader.json("docs/migration/rust-renderer-progress.json");
  for (const id of ["M0", "M1", "M2", "M3"])
    assert.equal(ledger.milestones.find((m) => m.id === id)?.status, "done");
  const milestone = ledger.milestones.find((m) => m.id === "M4");
  for (let i = 1; i <= 5; i++)
    assert.equal(milestone.tasks.find((t) => t.id === `M4-T${i}`)?.status, "done");
  assert(["in_progress", "done"].includes(milestone.tasks.find((t) => t.id === "M4-T6")?.status));
  const inputs = ledger.milestones.find((m) => m.id === "M3");
  const manifest = await reader.json(inputs.input_manifest.path, inputs.input_manifest.sha256);
  const capture = await reader.json(inputs.input_capture.path, inputs.input_capture.sha256);
  assert.equal(capture.status, "passed");
  const corpus = await reader.json("tests/parity/corpus.json", manifest.corpus_sha256);
  const { native, selected } = validateM4Gates(report, corpus);
  assert.deepEqual(native.input_manifest, inputs.input_manifest);
  for (const file of [native.binary, native.dxcompiler].filter(Boolean))
    await reader.bytes(file.path, file.sha256);
  const base = posix.dirname(inputs.input_manifest.path);
  const pixels = await auditNativePixels(reader, native, selected, report, base, false);
  const batch = await reader.json(
    native.effect_batch.request.path,
    native.effect_batch.request.sha256,
  );
  const effects = native.frames.filter((frame) => nativeEffectCases.includes(frame.case_id));
  assert.equal(batch.length, effects.length);
  for (const [index, frame] of effects.entries()) {
    assert.equal(frame.receipt.frame_index, index);
    assert.equal(frame.receipt.renderer_reused, index > 0);
    assert.equal(batch[index].plan, frame.input.path);
    assert.equal(batch[index].out, frame.receipt.output);
    assert.equal(batch[index].resources, `${base}/${frame.case_id}/frame-resources`);
  }
  assert.deepEqual(native.effect_batch.rejections.map((r) => r.id).sort(), [
    "duplicate",
    "limit",
    "partial",
  ]);
  for (const rejection of native.effect_batch.rejections) {
    assert.equal(rejection.rejected, true);
    assert.equal(rejection.complete_frames_preserved, true);
    validateCurrentStep(rejection.step, report.started_at, true);
    await reader.bytes(rejection.step.log);
  }
  const cacheLog = (await reader.bytes(native.image_cache.log)).bytes.toString("utf8");
  assert(
    cacheLog.includes(
      "native_layer_cache_reuses_invalidates_and_falls_back_without_pixel_changes ... ok",
    ),
  );
  const supplements = await auditM4Supplements(reader, native, report, ledger);
  return {
    status: "passed",
    scope: "M4 effects and layer styles with retained core regressions",
    native_gpu_execution: true,
    effect_cases: nativeEffectCases.length,
    effect_frames: effects.length,
    pixels,
    supplements,
    boundaries: [
      "Full-resolution SSAA retained after reduced-grid rejection",
      "Unknown bounds/history retain full execution",
      "Legacy nonzero base blur/glow are not emitted by the supplied production contract",
      "Higher-tier auxiliary transparency and generators remain M7",
      "Frozen color-range and twister references are transparent; parity does not establish nonempty output",
    ],
    checked_files: await reader.stable(),
  };
}
