import assert from "node:assert/strict";
import { M0Evidence, stableSource, validSha } from "./m0-evidence.mjs";
import { auditM1Pixels } from "./m1-pixels.mjs";
import { staticCommands } from "./static-checks.mjs";

/** Reject partial, stale or internally inconsistent gate summaries before reading their artifacts. */
export function validateM2Gates(report, exact) {
  assert.equal(report.milestone, "M2");
  assert.equal(report.mode, "full", "Quick checks cannot establish M2 completion");
  assert.deepEqual([...report.required_gates].sort(), ["G0", "G1", "G3"]);
  assert.deepEqual(report.gates.map((gate) => gate.id).sort(), ["G0", "G1", "G3"]);
  assert(
    report.gates.every((gate) => gate.status === "passed"),
    "Current full gates must pass",
  );
  const [g0, ir, g3] = ["G0", "G1", "G3"].map((id) => report.gates.find((gate) => gate.id === id));
  for (const command of staticCommands()) {
    const steps = g0.steps.filter((step) => step.id === command.id);
    assert.equal(steps.length, 1, `Missing or duplicate G0 step: ${command.id}`);
    assert.equal(steps[0].status, "passed");
    assert.equal(steps[0].exit_code, 0);
  }
  for (const evidence of [ir, exact]) {
    assert.equal(evidence.status, "passed");
    assert.equal(evidence.source_unchanged, true);
    stableSource(evidence.source, evidence.source_after, "source_sha256");
    assert.equal(evidence.source.source_sha256, validSha(report.source.source_sha256));
    assert(Date.parse(evidence.started_at) >= Date.parse(report.started_at), "Stale M2 evidence");
  }
  stableSource(exact.renderer_source, exact.renderer_source_after, "renderer_source_sha256");
  assert.equal(exact.renderer_source.tree_sha256, report.source.source_sha256);
  assert.equal(ir.binary.sha256, exact.renderer_source.ir_cli_sha256);
  assert.equal(exact.build.status, "passed");
  assert.equal(exact.build.exit_code, 0);
  assert.equal(exact.gate.status, "passed");
  assert.equal(exact.gate.scope, "full");
  assert.equal(exact.gate.full_coverage, true);
  assert.equal(exact.gate.inputs_unchanged, true);
  assert.equal(g3.source_unchanged, true);
  for (const key of ["frames", "required_count", "comparisons", "reference_binding"])
    assert.deepEqual(g3[key], exact.gate[key], `G3 wrapper differs: ${key}`);
  assert.equal(ir.resources.status, "passed");
  for (const check of [
    "descriptor_content_hash",
    "wrong_hash",
    "input_ownership",
    "idempotent_put",
    "budget_atomicity",
    "atomic_pin",
    "pinned_eviction",
    "missing_resource",
  ])
    assert(ir.resources.checks.includes(check), `Missing resource lifetime check: ${check}`);
  for (const kind of ["media_resources", "raster_pixels"])
    assert.equal(ir[kind].dependency_eviction, true);
  assert(ir.roundtrips.length > 0 && ir.roundtrips.every((item) => item.exact));
  assert(ir.frame_bundles.length >= 3, "Missing recursive, empty or temporal frame transport");
  for (const bundle of ir.frame_bundles) {
    for (const key of [
      "exact_payloads",
      "exact_dependencies",
      "missing_rejected",
      "corrupt_rejected",
      "rust_count_rejected",
    ])
      assert.equal(bundle[key], true);
    for (const key of [
      "exact",
      "missing_rejected",
      "execution_change_rejected",
      "discovery_rejected",
      "corrupt_rejected",
    ])
      assert.equal(bundle.capture_admission[key], true);
  }
  for (const key of [
    "raster_resources",
    "frame_artifacts",
    "temporal_text",
    "encoded_textures",
    "material_draws",
    "lut_draws",
    "root_scenes",
    "generators",
    "precompositions",
    "auxiliary",
    "auxiliary_generators",
    "output_replay",
  ]) {
    assert.equal(exact[key]?.status, "passed", `Missing supplied execution evidence: ${key}`);
    assert.deepEqual(g3[key], exact[key], `G3 replay wrapper differs: ${key}`);
  }
  assert.equal(exact.frame_artifacts.exact_rust_roundtrip, true);
  assert.equal(exact.frame_artifacts.exact_ts_replay, true);
  return { ir, g3 };
}

/** M2 acceptance binds this run's gates to the complete corpus and actual submitted frame files. */
export async function auditM2Exit(root, report) {
  const reader = new M0Evidence(root);
  const ledger = await reader.json("docs/migration/rust-renderer-progress.json");
  for (const id of ["M0", "M1"])
    assert.equal(
      ledger.milestones.find((item) => item.id === id)?.status,
      "done",
      `M2 requires completed ${id}`,
    );
  const milestone = ledger.milestones.find((item) => item.id === "M2");
  for (let index = 1; index <= 14; index++)
    assert.equal(milestone.tasks.find((item) => item.id === `M2-T${index}`)?.status, "done");
  const task = milestone.tasks.find((item) => item.id === "M2-T15");
  assert(["in_progress", "done"].includes(task?.status));
  const g3 = report.gates.find((gate) => gate.id === "G3");
  const exact = await reader.json(g3.ts_verification);
  const { ir } = validateM2Gates(report, exact);
  assert.deepEqual(exact.frozen_reference, milestone.frozen_reference);
  assert.deepEqual(exact.gate.reference_binding, milestone.frozen_reference);
  await reader.bytes(ir.schema.path, ir.schema.sha256);
  await reader.bytes(ir.schema.generated, ir.schema.sha256);
  await reader.bytes(ir.binary.path, ir.binary.sha256);
  for (const item of ir.roundtrips) {
    await reader.bytes(item.input, item.sha256);
    await reader.bytes(item.output, item.sha256);
  }
  const corpus = await reader.json("tests/parity/corpus.json");
  const pixels = await auditM1Pixels(reader, exact, corpus, milestone.frozen_reference);
  const candidate = await reader.json(
    exact.candidate_manifest.path,
    exact.candidate_manifest.sha256,
  );
  assert.equal(exact.frame_artifacts.cases, corpus.cases.length);
  assert.equal(exact.frame_artifacts.frames, candidate.captured_frame_count);
  assert.equal(exact.frame_artifacts.cases, candidate.cases.length);
  assert.equal(candidate.source.ir_cli_sha256, ir.binary.sha256);
  assert.equal(
    candidate.source.renderer_source_sha256,
    exact.renderer_source.renderer_source_sha256,
  );
  const boundary = task.execution_boundary_audit;
  assert.equal(boundary?.status, "reviewed");
  assert.equal(boundary.project_evaluation_in_executor, false);
  assert(boundary.files.length >= 8, "Missing execution boundary source audit");
  for (const file of boundary.files) await reader.bytes(file.path, file.sha256);
  const incident = task.rejected_capture_disposition;
  assert.equal(incident?.verdict, "rejected-not-reproduced");
  assert.equal(incident.root_cause, "unknown");
  const failed = await reader.json(incident.report.path, incident.report.sha256);
  assert.equal(failed.status, "failed", "Historical rejection must stay rejected");
  const current = exact.gate.comparisons.find(
    (item) => item.case_id === incident.case_id && item.frame === incident.frame,
  );
  assert.equal(
    current?.comparison.metrics.exact,
    true,
    "Incident address must pass current exact comparison",
  );
  for (const file of incident.rejection_guard) await reader.bytes(file.path, file.sha256);
  return {
    status: "passed",
    renderer_plan_complete: true,
    native_gpu_execution: false,
    schema: ir.schema,
    frame_artifacts: exact.frame_artifacts,
    exact: {
      report: g3.ts_verification,
      required_frames: exact.gate.required_count,
      audited_files: pixels,
      candidate_manifest: exact.candidate_manifest,
    },
    execution_boundary: boundary,
    historical_rejection: { ...incident, current_exact_comparison: current.evidence },
    checked_files: await reader.stable(),
  };
}
