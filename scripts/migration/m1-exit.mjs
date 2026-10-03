import assert from "node:assert/strict";
import { auditEffectShotFiles } from "../parity/effect-shots.mjs";
import { M0Evidence, stableSource, validSha } from "./m0-evidence.mjs";
import { auditM1Pixels } from "./m1-pixels.mjs";
import { auditSharedShaderSources } from "./shared-shaders.mjs";
import { staticCommands } from "./static-checks.mjs";

/** Bind complete shader extraction to the gates executed by this verification run. */
export async function auditM1Exit(root, report, dependencies = {}) {
  assert.equal(report.milestone, "M1");
  assert.equal(report.mode, "full", "Quick checks cannot establish M1 completion");
  const reader = new M0Evidence(root);
  const ledger = await reader.json("docs/migration/rust-renderer-progress.json");
  const milestone = ledger.milestones.find((item) => item.id === "M1");
  assert(milestone, "M1 is absent from the ledger");
  assert.equal(ledger.milestones.find((item) => item.id === "M0")?.status, "done");
  for (let index = 1; index <= 5; index++) {
    assert.equal(
      milestone.tasks.find((task) => task.id === `M1-T${index}`)?.status,
      "done",
      "A prerequisite M1 task remains open",
    );
  }
  assert(
    ["in_progress", "done"].includes(milestone.tasks.find((task) => task.id === "M1-T6")?.status),
    "M1 extraction exit task is not active",
  );
  assert.deepEqual([...report.required_gates].sort(), ["G0", "G3"]);
  assert.deepEqual(report.gates.map((gate) => gate.id).sort(), ["G0", "G3"]);
  const g0 = report.gates.find((gate) => gate.id === "G0");
  const g3 = report.gates.find((gate) => gate.id === "G3");
  assert.equal(g0.status, "passed", "Current full G0 must pass");
  for (const command of staticCommands()) {
    const steps = g0.steps.filter((step) => step.id === command.id);
    assert.equal(steps.length, 1, `Missing or duplicate current G0 step: ${command.id}`);
    assert.equal(steps[0].status, "passed");
    assert.equal(steps[0].exit_code, 0);
  }
  assert.equal(g3.status, "passed", "Current full exact G3 must pass");
  assert.equal(g3.source_unchanged, true);
  const exact = await reader.json(g3.ts_verification);
  assert.equal(exact.status, "passed");
  assert.equal(exact.source_unchanged, true);
  assert.equal(exact.build.status, "passed");
  assert.equal(exact.build.exit_code, 0);
  stableSource(exact.source, exact.source_after, "source_sha256");
  stableSource(exact.renderer_source, exact.renderer_source_after, "renderer_source_sha256");
  assert.equal(exact.source.source_sha256, validSha(report.source.source_sha256));
  assert.equal(exact.renderer_source.tree_sha256, report.source.source_sha256);
  assert(
    Date.parse(exact.started_at) >= Date.parse(report.started_at),
    "M1 exit cannot reuse a previous run's pixel comparison",
  );
  assert.equal(exact.gate.status, "passed");
  assert.equal(exact.gate.scope, "full");
  assert.equal(exact.gate.full_coverage, true);
  assert.equal(exact.gate.inputs_unchanged, true);
  assert.deepEqual(exact.gate.reference_binding, milestone.frozen_reference);
  assert.deepEqual(exact.frozen_reference, milestone.frozen_reference);
  for (const key of ["frames", "required_count", "comparisons", "reference_binding"])
    assert.deepEqual(g3[key], exact.gate[key], `G3 wrapper differs from TS evidence: ${key}`);
  const corpus = await reader.json("tests/parity/corpus.json");
  const pixels = await auditM1Pixels(reader, exact, corpus, milestone.frozen_reference);
  const shared = await (dependencies.auditSharedShaderSources ?? auditSharedShaderSources)(root);
  assert.equal(shared.status, "passed");
  assert.equal(shared.inline_wgsl_count, 0);
  assert.equal(shared.coverage.disk_matches_manifest, true);
  assert.equal(shared.coverage.all_fragments_referenced, true);
  for (const file of [...shared.source_files, ...shared.shader_files])
    await reader.bytes(file.path, file.sha256);
  await reader.bytes(shared.manifest.path, shared.manifest.sha256);
  const native = report.native_effect_shots;
  assert.equal(native?.status, "passed", "Native shared-effect shader smoke must pass");
  const smoke = await reader.json(native.report_path, native.report_sha256);
  assert.equal(smoke.kind, "native-effect-shader-smoke");
  assert.equal(smoke.status, "passed");
  assert.equal(smoke.source_sha256, report.source.source_sha256);
  assert(
    Date.parse(smoke.started_at) >= Date.parse(report.started_at),
    "M1 exit cannot reuse a previous native shader smoke",
  );
  await reader.bytes(smoke.manifest.path, smoke.manifest.sha256);
  const nativeFiles = await (dependencies.auditEffectShotFiles ?? auditEffectShotFiles)(
    root,
    smoke,
  );
  assert.equal(nativeFiles.status, "passed", "Native effect output files failed audit");
  return {
    status: "passed",
    shared_shaders: shared,
    naga: { status: "passed", gate: "G0", step: "cargo-test", source: report.source.source_sha256 },
    exact: {
      report: g3.ts_verification,
      required_frames: exact.gate.required_count,
      renderer_source_sha256: exact.renderer_source.renderer_source_sha256,
      reference_binding: milestone.frozen_reference,
      candidate_manifest: exact.candidate_manifest,
      audited_files: pixels,
    },
    native_effect_shots: native,
    native_files: nativeFiles,
    checked_files: await reader.stable(),
  };
}
