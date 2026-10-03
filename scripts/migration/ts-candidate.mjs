import assert from "node:assert/strict";
import { digest } from "../parity/provenance.mjs";
import { auditCandidate, auditCaptureSet, capturedCaseSet } from "./m0-captures.mjs";
import { validSha } from "./m0-evidence.mjs";

function frozenReference(ledger, requestedMilestone) {
  const milestone =
    requestedMilestone ?? ledger.milestones.find((item) => item.status !== "done")?.id;
  if (!["M1", "M2"].includes(milestone)) return null;
  const m0 = ledger.milestones.find((item) => item.id === "M0");
  const exit = m0?.tasks.find((item) => item.id === "M0-T6");
  const m1 = ledger.milestones.find((item) => item.id === "M1");
  assert.equal(m0?.status, "done", "TS refactoring requires completed M0 evidence");
  assert.equal(exit?.status, "done", "The M0 reference set has not been finalized");
  const frozen = m1?.frozen_reference;
  assert(frozen && Array.isArray(frozen.repairs), "M1 frozen reference binding is missing");
  validSha(frozen.base_renderer_source_sha256);
  validSha(frozen.repairs_sha256);
  assert.deepEqual(
    frozen,
    exit.effective_reference,
    "M1 reference differs from the completed M0 reference",
  );
  assert.equal(
    ledger.reference_baseline?.renderer_source_sha256,
    frozen.base_renderer_source_sha256,
    "The pre-change reference renderer source was changed",
  );
  assert.equal(
    digest(ledger.reference_repairs ?? []),
    frozen.repairs_sha256,
    "Reference repairs changed after M0 completion",
  );
  const declared = ledger.milestones.find((item) => item.id === milestone)?.frozen_reference;
  if (declared)
    assert.deepEqual(declared, frozen, "Milestone reference differs from the frozen TS reference");
  return frozen;
}

async function auditFrozenOriginals(reader, ledger, corpus, reference) {
  const exit = ledger.milestones
    .find((item) => item.id === "M0")
    .tasks.find((item) => item.id === "M0-T6");
  const verification = await reader.json(exit.verification);
  assert.equal(verification.schema_version, 1);
  assert.equal(verification.milestone, "M0");
  assert.equal(verification.mode, "full");
  assert.equal(verification.status, "passed", "Completed M0 verification did not pass");
  assert.equal(verification.required_gates_passed, true);
  assert.equal(verification.milestone_exit_satisfied, true);
  assert.equal(verification.milestone_exit?.status, "passed");
  const frozen = verification.milestone_exit.reference;
  assert.equal(frozen.renderer_source_sha256, reference.base_renderer_source_sha256);
  validSha(frozen.digest);
  const originalReport = await reader.json(ledger.reference_baseline.capture_report);
  capturedCaseSet(originalReport, corpus);
  assert.equal(originalReport.source.renderer_source_sha256, reference.base_renderer_source_sha256);
  const originals = await auditCaptureSet(
    reader,
    corpus,
    "artifacts/parity/reference",
    reference.base_renderer_source_sha256,
    undefined,
    {
      run_id: originalReport.run_id,
      source: originalReport.source,
      host: originalReport.host,
      caseStatus: new Map(originalReport.cases.map((item) => [item.id, item.status])),
    },
  );
  assert.equal(originals.captures.size, frozen.cases);
  assert.equal(originals.frames.size, frozen.frames);
  assert.equal(
    corpus.cases.reduce((count, item) => count + item.frames.length, 0),
    frozen.required_frames,
  );
  assert.equal(originals.digest, frozen.digest, "Frozen original reference bytes differ");
  return originals;
}

/** Bind every captured byte to the current TS renderer and to the completed pre-change oracle. */
export async function auditTsCandidate(reader, manifestPath, rendererSource, milestone) {
  const ledger = await reader.json("docs/migration/rust-renderer-progress.json");
  const reference = frozenReference(ledger, milestone);
  const corpus = await reader.json("tests/parity/corpus.json");
  const manifest = await reader.json(manifestPath);
  assert(
    typeof manifest.run_id === "string" && /^[a-zA-Z0-9][a-zA-Z0-9-]{0,127}$/.test(manifest.run_id),
    "Candidate capture run ID is unsafe or missing",
  );
  const captureReportPath = `artifacts/parity/capture-${manifest.run_id}.json`;
  const captured = await auditCandidate(
    reader,
    corpus,
    manifestPath,
    captureReportPath,
    validSha(rendererSource.renderer_source_sha256),
  );
  if (reference) {
    const originals = await auditFrozenOriginals(reader, ledger, corpus, reference);
    assert.deepEqual(
      captured.captures,
      originals.captures,
      "Candidate project/media/frame inputs differ from the frozen reference",
    );
  }
  return { captured, captureReportPath, reference };
}
