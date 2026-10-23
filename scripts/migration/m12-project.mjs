import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { captureAssignments } from "../parity/provenance.mjs";
import { checkpointSource } from "./checkpoint-source.mjs";
import { assertEvaluationCoverage, assertExportCoverage } from "./m9-coverage.mjs";
import { auditM9ExportOrigins, auditM9ModelCoverage } from "./m9-exit.mjs";

/** G3 already checked image bytes and numeric limits; bind its decisions to accepted ledger reviews. */
export async function auditProductionPixelReviews(reader, gate, ledger) {
  const reviews = new Map(ledger.self_reviews.map((r) => [r.evidence?.report, r]));
  assert.deepEqual(
    gate.evidence,
    gate.comparisons.map((r) => r.evidence),
  );
  assert.equal(gate.frames.length, gate.comparisons.length);
  let reviewed = 0;
  for (const [index, frame] of gate.frames.entries()) {
    const record = gate.comparisons[index];
    assert.equal(record.case_id, frame.case_id);
    assert.equal(record.frame, frame.frame);
    assert.equal(frame.status, "passed");
    assert.equal(frame.step.status, "passed");
    assert.equal(frame.step.exit_code, 0);
    assert(!frame.step.error && !frame.step.signal);
    assert.deepEqual(frame.evidence, record.evidence);
    const raw = await reader.json(record.evidence.report, record.evidence.report_sha256);
    assert.deepEqual(raw.comparison, record.comparison);
    assert.equal(raw.comparison.passed, true);
    assert.equal(raw.comparison.profile.name, frame.profile);
    if (frame.profile !== "exact") {
      assert.equal(frame.self_review_required, true);
      const review = reviews.get(frame.self_review?.report);
      assert.equal(review?.verdict, "accepted");
      assert(
        ["float-precision", "decoder-rounding", "sampling-order", "shaping-hinting"].includes(
          review.residual_class,
        ),
      );
      assert.equal(review.case_id, frame.case_id);
      assert.equal(review.frame, frame.frame);
      assert.deepEqual(review.evidence, frame.self_review);
      const accepted = await reader.json(
        review.evidence.report,
        review.evidence.report_sha256 ?? review.report_sha256,
      );
      assert.equal(accepted.context.case_id, frame.case_id);
      for (const key of [
        "passed",
        "profile",
        "width",
        "height",
        "reference_rgba_sha256",
        "candidate_rgba_sha256",
        "metrics",
        "ssim",
        "structural",
        "registration",
        "sequence",
      ])
        assert.deepEqual(accepted.comparison[key], raw.comparison[key]);
      reviewed++;
    }
  }
  return { status: "passed", frames: gate.frames.length, reviewed };
}

export async function auditProductionProjects(reader, root, { gates, ledger, source, env }) {
  const file = await reader.bytes("tests/parity/corpus.json"),
    corpus = JSON.parse(file.bytes);
  const assignments = await captureAssignments(root, corpus.cases, env, { planReferences: true });
  const coverage = assertEvaluationCoverage(corpus, assignments, gates.G2, gates.G3.project);
  const models = await auditM9ModelCoverage(root, gates.G1, assignments, file.sha256);
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
  assert.equal(frozen.corpus_sha256, file.sha256);
  const sources = await checkpointSource({ root, source }, gates.G2);
  sources.assert((gates.G2.execution_source ?? gates.G2.source).execution_sha256);
  const jobs = await reader.json(`${dirname(gates.G2.candidates.path)}/batch.json`);
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
  const pixels = await auditProductionPixelReviews(reader, gates.G3.project, ledger);
  const exports = assertExportCoverage(corpus, gates.G5);
  assert.equal(gates.G5.corpus_sha256, file.sha256);
  const exportAssignments = await captureAssignments(root, corpus.cases, env);
  const origins = await auditM9ExportOrigins(reader, root, gates.G5, exportAssignments, source);
  return { corpus, coverage, models, pixels, exports, export_origins: origins };
}
