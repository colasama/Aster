import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import { join, relative, toNamespacedPath } from "node:path";
import { decodeRgbaPng } from "../parity/png.mjs";
import { auditExecutionArtifacts } from "../performance/execution-artifacts.mjs";
import { loadRetainedPerformanceRuntime } from "../performance/retained-runtime.mjs";
import { auditDiagnosticStructuralWitness } from "./diagnostic-structural-audit.mjs";
import { auditUniformReference } from "./encoded-reference-domain.mjs";
import {
  encodedStructuralAlternatives,
  encodedStructuralPolicy,
} from "./encoded-structural-policy.mjs";
import { M0Evidence, validSha } from "./m0-evidence.mjs";
import { auditExportCaseEvidence } from "./native-export-evidence.mjs";
import { auditProjectExportEvidence } from "./native-project-export-evidence.mjs";
import { auditProjectStructuralWitness } from "./native-project-witness-review.mjs";
import { hashFile } from "./source.mjs";
import { auditStructuralWitness, layeredFrameReview } from "./structural-witness-audit.mjs";

/** Pin every per-case output before publication; the shared runtime has its own immutable manifest. */
export async function exportCaseFiles(root, directory) {
  const files = [];
  async function visit(path) {
    for (const item of await readdir(path, { withFileTypes: true })) {
      const file = join(path, item.name);
      assert(!item.isSymbolicLink(), "Export checkpoint cannot contain links");
      if (item.isDirectory()) await visit(file);
      else {
        assert(item.isFile());
        files.push({
          path: relative(root, file).replaceAll("\\", "/"),
          sha256: await hashFile(file),
        });
      }
    }
  }
  await visit(directory);
  return files.sort((a, b) => a.path.localeCompare(b.path, "en"));
}

export async function auditExportCheckpoint(context, checkpoint, assignment, referenceBinding) {
  assert.equal(checkpoint.schema_version, 1);
  if (context.checkpointSources) context.checkpointSources.assert(checkpoint.execution_sha256);
  else
    assert.equal(
      validSha(checkpoint.execution_sha256),
      validSha(context.source.execution_sha256),
      "Export code changed since checkpoint",
    );
  assert.deepEqual(checkpoint.assignment, assignment, "Export inputs changed since checkpoint");
  assert.deepEqual(
    checkpoint.reference_binding,
    referenceBinding,
    "Frozen reference binding changed",
  );
  const reader = new M0Evidence(context.root);
  assert(checkpoint.files.length > 0);
  assert.equal(new Set(checkpoint.files.map((f) => f.path)).size, checkpoint.files.length);
  for (const file of checkpoint.files) await reader.bytes(file.path, validSha(file.sha256));
  assert(
    checkpoint.files.some(
      (f) => f.path === checkpoint.report.path && f.sha256 === checkpoint.report.sha256,
    ),
  );
  const report = await reader.json(checkpoint.report.path, checkpoint.report.sha256);
  assert.equal(report.status, "measured");
  assert.equal(report.source_unchanged, true);
  assert.equal(report.source.execution_sha256, checkpoint.execution_sha256);
  assert.equal(report.source.source_sha256, report.source_after.source_sha256);
  assert.equal(report.cases.length, 1);
  assert.equal(report.cases[0].id, assignment.case.id);
  assert.deepEqual(report.assignments[0].inputs, assignment.inputs);
  assert.deepEqual(report.reference_binding, referenceBinding);
  await auditExportCaseEvidence(context.root, report, assignment);
  if (report.kind === "native-project-export")
    await auditProjectExportEvidence(context.root, report.execution, report.assignments[0]);
  if (report.cases[0].structural_witness)
    await (report.kind === "native-project-export"
      ? auditProjectStructuralWitness
      : auditStructuralWitness)(
      context.root,
      report.cases[0],
      report,
      await reader.json("docs/migration/rust-renderer-progress.json"),
      context.referenceInputs,
    );
  await auditExecutionArtifacts(context.root, report.execution.execution);
  for (const file of report.execution.binaries) await reader.bytes(file.path, file.sha256);
  const retained = await loadRetainedPerformanceRuntime(context.root);
  assert.deepEqual(report.execution.retained, retained.provenance);
  await retained.assertStable();
  await reader.stable();
  return report;
}

/** Layered acceptance retains the flat failure and requires independently audited witnesses. */
export async function reviewExportCase(root, entry, ledger, execution, referenceInputs) {
  const reader = new M0Evidence(root);
  const reviews = [];
  const witness = entry.structural_witness
    ? await (execution?.kind === "native-project-export"
        ? auditProjectStructuralWitness
        : execution?.status === "diagnostic"
          ? auditDiagnosticStructuralWitness
          : auditStructuralWitness)(root, entry, execution, ledger, referenceInputs)
    : null;
  assert(entry.frames.length > 0 && new Set(entry.frames).size === entry.frames.length);
  assert.equal(entry.comparisons.length, entry.frames.length * 2);
  for (const frame of entry.comparisons) {
    const raw = await reader.json(frame.report, frame.report_sha256);
    const c = raw.comparison;
    assert.equal(raw.context.case_id, entry.id);
    assert.equal(c.profile.name, "yuv");
    for (const key of ["metrics", "structural", "registration", "sequence", "checks"])
      assert.deepEqual(frame[key], c[key]);
    assert.equal(
      c.passed,
      c.checks.every((check) => check.passed),
    );
    assert.equal(frame.passed, c.passed);
    if (c.registration?.status === "uniform_reference_equivalence") {
      const pixels = [];
      for (const side of ["reference", "candidate"])
        pixels.push(
          decodeRgbaPng(
            (
              await reader.bytes(
                relative(toNamespacedPath(root), toNamespacedPath(raw[side].path)).replaceAll(
                  "\\",
                  "/",
                ),
                raw[side].png_sha256,
              )
            ).bytes,
          ),
        );
      auditUniformReference(raw, ...pixels);
    }
    assert(["native", "ts"].includes(frame.name), "Unknown export comparison arm");
    for (const side of ["reference", "candidate"])
      await reader.bytes(
        relative(toNamespacedPath(root), toNamespacedPath(raw[side].path)).replaceAll("\\", "/"),
        raw[side].png_sha256,
      );
    const originalFrame = Math.min(...entry.frames) + frame.index;
    const candidates = ledger.self_reviews.filter(
      (r) =>
        r.purpose !== encodedStructuralPolicy &&
        r.profile === "yuv" &&
        r.frame === originalFrame &&
        r.reference_rgba_sha256 === c.reference_rgba_sha256 &&
        r.candidate_rgba_sha256 === c.candidate_rgba_sha256,
    );
    let review, prior;
    // Identical pixels can occur in different cases; only the authenticated report identifies the case.
    for (const candidate of candidates.toReversed()) {
      const evidence = await reader.json(
        candidate.evidence.report,
        candidate.evidence.report_sha256,
      );
      if (evidence.context.case_id !== raw.context.case_id) continue;
      review = candidate;
      prior = evidence;
      break;
    }
    let accepted = c.metrics.exact;
    if (!accepted && review) {
      assert(["accepted", "rejected"].includes(review.verdict), "Invalid review verdict");
      assert(
        [
          "float-precision",
          "decoder-rounding",
          "sampling-order",
          "shaping-hinting",
          "structural",
        ].includes(review.residual_class),
        "Invalid residual class",
      );
      assert.equal(prior.comparison.reference_rgba_sha256, c.reference_rgba_sha256);
      assert.equal(prior.comparison.candidate_rgba_sha256, c.candidate_rgba_sha256);
      for (const key of ["metrics", "ssim", "structural", "registration", "sequence", "checks"]) {
        assert.deepEqual(review[key], c[key]);
        assert.deepEqual(prior.comparison[key], c[key]);
      }
      for (const name of ["contact_sheet", "heatmap"])
        await reader.bytes(review.evidence[name], validSha(review.evidence[`${name}_sha256`]));
      accepted = review.verdict === "accepted" && review.residual_class !== "structural";
    }
    let layered = null;
    if (frame.name === "native" && !c.passed && witness) {
      const alternatives = encodedStructuralAlternatives(c);
      if (alternatives?.length) {
        const stage = witness.frames.find((f) => f.frame === originalFrame);
        assert(stage, "Missing addressed structural witness");
        const visual = await layeredFrameReview(
          reader,
          ledger,
          entry,
          originalFrame,
          raw,
          witness.witness,
          alternatives,
        );
        layered = {
          alternatives,
          witness: witness.witness,
          original_comparison_passed: false,
          stage,
          visual,
          status:
            stage.status === "failed" || visual.status === "failed"
              ? "failed"
              : stage.status === "passed" && visual.status === "passed"
                ? "passed"
                : "awaiting-self-review",
        };
      }
    }
    reviews.push({
      arm: frame.name,
      frame: originalFrame,
      reviewed: layered
        ? layered.status !== "awaiting-self-review"
        : c.metrics.exact || Boolean(review),
      ...(layered ? { layered } : {}),
      status: layered
        ? layered.status
        : !c.passed || review?.verdict === "rejected"
          ? "failed"
          : accepted
            ? "passed"
            : "awaiting-self-review",
    });
  }
  for (const arm of ["native", "ts"]) {
    const frames = entry.comparisons.filter((f) => f.name === arm);
    const start = Math.min(...entry.frames);
    assert.deepEqual(
      frames.map((f) => f.index),
      entry.frames.toSorted((a, b) => a - b).map((f) => f - start),
    );
  }
  const native = reviews.filter((r) => r.arm === "native");
  const numeric =
    native.every((r) => r.status !== "failed") && entry.quality.passed && entry.audio.passed;
  const reviewed = reviews.every((r) => r.reviewed && r.status !== "awaiting-self-review");
  await reader.stable();
  return {
    status: !numeric ? "failed" : reviewed ? "passed" : "awaiting-self-review",
    frames: reviews,
  };
}
