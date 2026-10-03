import assert from "node:assert/strict";
import { captureSource, digest } from "../parity/provenance.mjs";
import { validateCommittedBaseline } from "../performance/baseline.mjs";
import { auditCandidate, auditCaptureSet, capturedCaseSet } from "./m0-captures.mjs";
import { M0Evidence, stableSource, validSha } from "./m0-evidence.mjs";
import { auditComparison, auditOracle } from "./m0-pixels.mjs";
import { assertRepairIndependence, auditReferenceRepairs } from "./m0-reference-repairs.mjs";

/** Read-only milestone evidence audit; comparison and reference capture are separate operations. */
export async function auditM0Exit(root, options = {}, dependencies = {}) {
  const reader = new M0Evidence(root);
  const ledger = await reader.json("docs/migration/rust-renderer-progress.json");
  const milestone = ledger.milestones.find((item) => item.id === "M0");
  assert(milestone, "M0 is absent from the ledger");
  const task = (id) => milestone.tasks.find((item) => item.id === id);
  for (let index = 1; index <= 5; index++)
    assert.equal(task(`M0-T${index}`)?.status, "done", "A prerequisite M0 task remains open");
  const evidence = { ...task("M0-T6")?.exit_evidence, ...options };
  for (const key of ["exactReportPath", "candidateManifestPath", "candidateCaptureReportPath"])
    assert.equal(typeof evidence[key], "string", `M0 exit requires ${key}`);
  const corpus = await reader.json("tests/parity/corpus.json");
  assert.equal(new Set(corpus.cases.map((item) => item.id)).size, corpus.cases.length);
  for (const item of corpus.cases) {
    assert(
      item.frames.length > 0 &&
        item.frames.every((frame) => Number.isSafeInteger(frame) && frame >= 0),
    );
    assert.equal(new Set(item.frames).size, item.frames.length);
  }
  const required = corpus.cases.reduce((count, item) => count + item.frames.length, 0);
  const approved = ledger.reference_baseline;
  const original = task("M0-T3").reference_capture;
  assert.equal(approved.renderer_source_sha256, validSha(original.renderer_source_sha256));
  assert.equal(approved.capture_report, original.report);
  assert.equal(approved.case_count, corpus.cases.length);
  assert.equal(original.case_count, corpus.cases.length);
  assert.equal(original.requested_frame_count, required);
  const originalReport = await reader.json(approved.capture_report);
  capturedCaseSet(originalReport, corpus);
  assert.equal(originalReport.source.renderer_source_sha256, approved.renderer_source_sha256);
  const reference = await auditCaptureSet(
    reader,
    corpus,
    "artifacts/parity/reference",
    approved.renderer_source_sha256,
    undefined,
    {
      run_id: originalReport.run_id,
      source: originalReport.source,
      host: originalReport.host,
      caseStatus: new Map(originalReport.cases.map((item) => [item.id, item.status])),
    },
  );
  assert.equal(reference.frames.size, approved.frame_count);
  assert.equal(reference.frames.size, original.captured_frame_count);
  const catalogHash = (await reader.bytes("tests/parity/tolerances.json")).sha256;
  const oracle = await auditOracle(reader, ledger, task("M0-T4"), reference.frames, catalogHash);
  const repaired = await auditReferenceRepairs(
    reader,
    ledger,
    corpus,
    reference.frames,
    catalogHash,
  );
  const baseline = await (dependencies.validateBaseline ?? validateCommittedBaseline)(root);
  assert.equal(baseline.status, "passed");
  const expectedSource = (await (dependencies.captureSource ?? captureSource)(root))
    .renderer_source_sha256;
  validSha(expectedSource);
  const candidate = await auditCandidate(
    reader,
    corpus,
    evidence.candidateManifestPath,
    evidence.candidateCaptureReportPath,
    expectedSource,
  );
  await assertRepairIndependence(reader, candidate, repaired.repairs);
  assert.equal(candidate.frames.size, reference.frames.size);
  for (const [id, value] of reference.captures)
    assert.deepEqual(
      candidate.captures.get(id),
      value,
      "Candidate project/media/frame inputs differ from the reference",
    );
  const exact = await reader.json(evidence.exactReportPath);
  assert.equal(exact.schema_version, 1);
  assert.equal(exact.status, "passed", "Whole-corpus exact TS evidence has not passed");
  assert.equal(exact.source_unchanged, true);
  assert.equal(exact.build.status, "passed");
  assert.equal(exact.build.exit_code, 0);
  stableSource(exact.source, exact.source_after, "source_sha256");
  stableSource(exact.renderer_source, exact.renderer_source_after, "renderer_source_sha256");
  assert.equal(exact.renderer_source.renderer_source_sha256, expectedSource);
  assert.equal(exact.renderer_source.tree_sha256, exact.source.source_sha256);
  assert.equal(exact.candidate_manifest.path, evidence.candidateManifestPath);
  assert.equal(exact.candidate_manifest.sha256, candidate.manifestHash);
  assert.equal(exact.gate.scope, "full");
  assert.equal(exact.gate.full_coverage, true);
  assert.equal(exact.gate.required_count, required);
  if (repaired.repairs.length)
    assert.deepEqual(
      exact.gate.reference_binding,
      {
        base_renderer_source_sha256: approved.renderer_source_sha256,
        repairs_sha256: digest(ledger.reference_repairs),
        repairs: repaired.repairs,
      },
      "Exact comparison used different reference repairs",
    );
  await auditComparison(
    reader,
    exact.gate,
    "exact",
    true,
    repaired.effective,
    candidate.requested,
    catalogHash,
  );
  const checkedFiles = await reader.stable();
  return {
    status: "passed",
    reference: {
      cases: corpus.cases.length,
      frames: reference.frames.size,
      required_frames: required,
      renderer_source_sha256: approved.renderer_source_sha256,
      digest: reference.digest,
      repairs: repaired.repairs,
    },
    oracle,
    baseline,
    exact: {
      report: evidence.exactReportPath,
      required_frames: required,
      renderer_source_sha256: expectedSource,
      candidate_manifest: evidence.candidateManifestPath,
      candidate_manifest_sha256: candidate.manifestHash,
    },
    checked_files: checkedFiles,
  };
}
