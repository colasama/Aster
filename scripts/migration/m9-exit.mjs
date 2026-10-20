import assert from "node:assert/strict";
import { stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { captureAssignments } from "../parity/provenance.mjs";
import { checkpointSource } from "./checkpoint-source.mjs";
import { M0Evidence } from "./m0-evidence.mjs";
import { assertEvaluationCoverage, assertExportCoverage } from "./m9-coverage.mjs";
import { assertM9ExitTasks, bindM9GateReports } from "./m9-gates.mjs";
import { auditM9Pixels } from "./m9-pixels.mjs";
import { ownerProject, sourceProvenance } from "./source.mjs";

/** The full gate invocation authenticates artifacts; exit closes coverage and provenance boundaries. */
export async function auditM9Exit(root, report) {
  const reader = new M0Evidence(root);
  const ledger = await reader.json("docs/migration/rust-renderer-progress.json");
  assertM9ExitTasks(ledger);
  const source = await sourceProvenance(root);
  assert.equal(source.source_sha256, report.source.source_sha256);
  assert.equal(source.execution_sha256, report.source.execution_sha256);
  const { gates, pins } = await bindM9GateReports(reader, report);
  const corpusFile = await reader.bytes("tests/parity/corpus.json");
  const corpus = JSON.parse(corpusFile.bytes);
  const env = (await ownerProject(process.env)).env;
  const assignments = await captureAssignments(root, corpus.cases, env, { planReferences: true });
  const coverage = assertEvaluationCoverage(corpus, assignments, gates.G2, gates.G3);
  const models = await auditM9ModelCoverage(root, gates.G1, assignments, corpusFile.sha256);
  const reference = ledger.milestones
    .find((m) => m.id === "M9")
    .tasks.find((t) => t.id === "M9-T16").plan_reference_manifest;
  assert.deepEqual(gates.G2.reference, reference);
  const frozen = await reader.json(reference.path, reference.sha256);
  assert.equal(frozen.kind, "ts-plan-reference");
  assert.equal(frozen.scope, "full");
  assert.equal(frozen.source_verified, true);
  assert.equal(frozen.random_times_per_case, 64);
  assert.equal(frozen.captured_samples, coverage.samples);
  assert.equal(frozen.corpus_sha256, corpusFile.sha256);
  const planSources = await checkpointSource({ root, source }, gates.G2);
  planSources.assert((gates.G2.execution_source ?? gates.G2.source).execution_sha256);
  const base = dirname(gates.G2.candidates.path);
  const jobs = await reader.json(`${base}/batch.json`);
  assert.equal(jobs.length, assignments.length);
  for (const [index, assignment] of assignments.entries()) {
    const entry = gates.G2.cases[index],
      job = jobs[index];
    assert.equal(resolve(job.project), assignment.projectPath);
    assert.equal(resolve(entry.render.command[0]), resolve(root, gates.G2.binaries[0].path));
    assert.equal(entry.render.command[entry.render.command.indexOf("--project") + 1], job.project);
    assert.equal(entry.render.command[entry.render.command.indexOf("--request") + 1], job.request);
    const receipt = await reader.json(entry.receipt.path, entry.receipt.sha256);
    assert.equal(receipt.kind, "native-project-render");
    assert.equal(receipt.status, "passed");
    assert.equal(receipt.raster_mode, "live");
    assert.equal(receipt.project.authored_sha256, assignment.inputs.project_sha256);
    assert.equal(receipt.frames.length, assignment.planSamples.samples.length);
  }
  const pixels = await auditM9Pixels(root, gates.G3, gates.G2, pins.G2, env);
  const exports = assertExportCoverage(corpus, gates.G5);
  assert.equal(gates.G5.corpus_sha256, corpusFile.sha256);
  const exportAssignments = await captureAssignments(root, corpus.cases, env);
  const exportOrigins = await auditM9ExportOrigins(
    reader,
    root,
    gates.G5,
    exportAssignments,
    source,
  );
  const checkedFiles = await reader.stable();
  const after = await sourceProvenance(root);
  assert.equal(after.source_sha256, source.source_sha256);
  assert.equal(after.execution_sha256, source.execution_sha256);
  return {
    status: "passed",
    native_evaluation_acceptance: true,
    headless_project_export_acceptance: true,
    models,
    coverage,
    pixels,
    exports,
    export_origins: exportOrigins,
    gate_reports: pins,
    checked_files: checkedFiles,
    retained_raster_boundary: ["text", "svg", "psd"],
    production_preview_acceptance: false,
  };
}

export async function auditM9ModelCoverage(root, gate, assignments, corpusSha) {
  assert.equal(gate.corpus_sha256, corpusSha);
  for (const key of [
    "runtime_projects",
    "project_media",
    "project_media_frames",
    "raster_requests",
    "resource_requests",
    "native_inputs",
    "native_file_inputs",
    "native_allocations",
    "scalar_evaluation",
    "expression_evaluation",
    "scene_evaluation",
    "path_evaluation",
    "scene_resources",
    "ir",
    "plan_cli",
    "plan_diff",
    "resource_cli",
    "project_roundtrip",
  ])
    assert.equal(gate[key]?.status, "passed", `Missing native component acceptance: ${key}`);
  const expected = new Map();
  for (const assignment of assignments) {
    assert(!assignment.unavailable);
    const path = (await stat(assignment.projectPath)).isDirectory()
      ? join(assignment.projectPath, "project.json")
      : assignment.projectPath;
    const record = expected.get(path) ?? { sha256: assignment.inputs.project_sha256, cases: [] };
    assert.equal(record.sha256, assignment.inputs.project_sha256);
    record.cases.push(assignment.case.id);
    expected.set(path, record);
  }
  assert.equal(gate.project_inputs.length, expected.size);
  const seen = new Set();
  for (const input of gate.project_inputs) {
    const path = resolve(root, input.path),
      record = expected.get(path);
    assert(record && !seen.has(path));
    seen.add(path);
    assert.equal(input.sha256, record.sha256);
    assert.deepEqual(input.cases, record.cases);
  }
  assert.equal(gate.project_roundtrip.projects, expected.size);
  assert.equal(gate.project_roundtrip.corpus_cases, assignments.length);
  return { projects: expected.size, cases: assignments.length, status: "passed" };
}

export async function auditM9ExportOrigins(reader, root, gate, assignments, source) {
  const exportSources = await checkpointSource({ root, source }, gate);
  for (const [index, entry] of gate.cases.entries()) {
    const checkpoint = await reader.json(entry.checkpoint.path, entry.checkpoint.sha256);
    assert.equal(checkpoint.schema_version, 1);
    assert.equal(checkpoint.kind, "native-project-export");
    exportSources.assert(checkpoint.execution_sha256);
    assert.deepEqual(checkpoint.assignment, assignments[index]);
    const original = await reader.json(checkpoint.report.path, checkpoint.report.sha256);
    assert.equal(original.kind, "native-project-export");
    assert.equal(original.status, "measured");
    assert.equal(original.source_unchanged, true);
    assert.equal(original.source.execution_sha256, checkpoint.execution_sha256);
    assert.equal(original.cases.length, 1);
    assert.deepEqual(entry.result, {
      ...original.cases[0],
      status: entry.status,
      review: entry.review,
    });
    assert.equal(original.execution.kind, "native-project-export");
    assert.equal(original.assignments.length, 1);
    const arm = await reader.json(
      original.execution.arms.rust.path,
      original.execution.arms.rust.sha256,
    );
    assert.deepEqual(arm, original.execution.arms.rust.raw);
    const run = arm.cases.find((value) => value.caseId === entry.id);
    assert(run);
    assert.equal(run.step.status, "passed");
    assert.equal(run.step.exit_code, 0);
    assert.equal(run.step.command[1], "export");
    for (const forbidden of ["--plan", "--batch", "--resources"])
      assert(!run.step.command.includes(forbidden));
    assert.equal(run.receipt.project.authored_sha256, assignments[index].inputs.project_sha256);
  }
  return { status: "passed", cases: gate.cases.length };
}
