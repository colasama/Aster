import assert from "node:assert/strict";
import { realpath } from "node:fs/promises";
import { posix, resolve } from "node:path";
import { auditCandidate } from "./m0-captures.mjs";
import { evidencePath, validSha } from "./m0-evidence.mjs";
import { auditComparisonEvidence } from "./m0-pixels.mjs";
import { auditMaterialReferenceRepairs } from "./material-reference-repair.mjs";

function bounded(value, maximum, name) {
  assert(Number.isFinite(value) && value >= 0 && value <= maximum, `${name} exceeds its limit`);
}

/** Review acceptance cannot change the checked-in profile or replace failed numerical checks. */
function auditGpuChecks(report, catalog, reference, frame) {
  const { comparison } = report;
  const profile = catalog.profiles.gpu;
  assert.equal(profile.exact, false);
  assert.deepEqual(
    comparison.profile.limits,
    {
      max_abs_channel_error: null,
      mean_abs_error: null,
      min_psnr_db: null,
      min_ssim: null,
      structural: null,
      ...profile,
    },
    "Repair comparison changed the GPU profile",
  );
  const expected = ["error_clusters", "signed_bias", "alpha_coverage", "registration"];
  const { metrics, structural, registration } = comparison;
  for (const name of ["max_abs_channel_error", "mean_abs_error"])
    if (profile[name] != null) {
      expected.push(name);
      bounded(metrics[name], profile[name], name);
    }
  if (profile.min_psnr_db != null) {
    expected.push("psnr");
    assert(
      metrics.psnr?.kind === "infinite" ||
        (metrics.psnr?.kind === "finite" &&
          Number.isFinite(metrics.psnr.db) &&
          metrics.psnr.db >= profile.min_psnr_db),
      "Repair PSNR failed",
    );
  }
  if (profile.min_ssim != null) {
    expected.push("ssim");
    assert(Number.isFinite(comparison.ssim?.mean) && comparison.ssim.mean >= profile.min_ssim);
  }
  assert.equal(structural.pixel_count, metrics.pixel_count);
  assert.equal(structural.cluster_error_threshold, 16);
  assert.equal(structural.alpha_error_threshold, 8);
  const limits = profile.structural;
  bounded(structural.largest_error_component, limits.largest_error_component, "Error cluster");
  bounded(structural.alpha_changed_fraction, limits.alpha_changed_fraction, "Alpha coverage");
  assert.equal(structural.signed_bias.length, 4);
  for (const bias of structural.signed_bias)
    bounded(Math.abs(bias), limits.max_abs_signed_bias, "Signed bias");
  assert(["measured", "exact_identity"].includes(registration.status));
  bounded(registration.shift?.distance, limits.registration_distance, "Registration");
  if (reference.isolated) {
    expected.push("ink_bounds");
    assert.deepEqual(report.context.background, [0, 0, 0, 0]);
    assert.deepEqual(structural.ink_bounds?.background, [0, 0, 0, 0]);
    assert.equal(structural.ink_bounds.same_emptiness, true);
    assert.equal(structural.ink_bounds.edge_deltas?.length, 4);
    for (const delta of structural.ink_bounds.edge_deltas)
      bounded(Math.abs(delta), limits.ink_edge_delta, "Ink bounds");
  }
  if (reference.sequence) {
    expected.push("frame_identity");
    const sequence = comparison.sequence;
    assert.equal(sequence.frame, frame);
    for (const name of ["first_frame", "last_frame"])
      assert.equal(sequence[name], reference.sequenceDomain[name]);
    assert.equal(sequence.current_mean_squared_error, metrics.mean_squared_error);
    for (const [name, neighbor] of [
      ["previous", frame - 1],
      ["next", frame + 1],
    ]) {
      if (neighbor < sequence.first_frame || neighbor > sequence.last_frame) continue;
      const result = sequence[name];
      assert.equal(result?.status, "compared");
      assert.equal(result.frame, neighbor);
      assert.equal(result.current_is_closer, true);
      assert(
        Number.isFinite(result.mean_squared_error) &&
          result.mean_squared_error > metrics.mean_squared_error,
        "Repair frame identity failed",
      );
    }
  }
  assert.deepEqual(
    comparison.checks.map((item) => item.id).sort(),
    expected.sort(),
    "Repair check set is incomplete, duplicated, or unexpected",
  );
}

/** Original references remain immutable; only explicitly reviewed requested frames are overlaid. */
export async function auditReferenceRepairs(reader, ledger, corpus, references, catalogHash) {
  const definitions = ledger.reference_repairs ?? [];
  assert(Array.isArray(definitions), "Reference repairs must be an array");
  const effective = new Map(references);
  const repairs = [];
  const seen = new Set();
  const snapshots = new Map();
  const materialRepairs = await auditMaterialReferenceRepairs(
    reader,
    ledger,
    corpus,
    references,
    definitions,
  );
  const catalog = definitions.length
    ? await reader.json("tests/parity/tolerances.json", catalogHash)
    : null;
  for (const repair of definitions) {
    assert(repair && typeof repair === "object", "Invalid reference repair");
    const item = corpus.cases.find((item) => item.id === repair.case_id);
    const key = `${repair.case_id}/${repair.frame}`;
    assert(
      item && Number.isSafeInteger(repair.frame) && item.frames.includes(repair.frame),
      "Reference repair must select a required corpus frame",
    );
    assert(!seen.has(key), "Duplicate reference repair");
    seen.add(key);
    const material = materialRepairs.get(key);
    if (material) {
      effective.set(key, material.replacement);
      repairs.push(material.evidence);
      continue;
    }
    assert(repair.kind === undefined, "Unknown reference repair kind");
    for (const name of ["directory", "capture_report", "candidate_manifest", "approval_review"])
      evidencePath(repair[name]);
    assert.equal(
      posix.dirname(repair.candidate_manifest),
      repair.directory,
      "Repair directory differs from its candidate manifest",
    );
    validSha(repair.renderer_source_sha256);
    const original = references.get(key);
    assert(original, "Original repair frame is absent");
    const cacheKey = JSON.stringify([
      repair.candidate_manifest,
      repair.capture_report,
      repair.renderer_source_sha256,
    ]);
    if (!snapshots.has(cacheKey))
      snapshots.set(
        cacheKey,
        await auditCandidate(
          reader,
          corpus,
          repair.candidate_manifest,
          repair.capture_report,
          repair.renderer_source_sha256,
        ),
      );
    const snapshot = snapshots.get(cacheKey);
    const replacement = snapshot.requested.get(key);
    assert(replacement, "Repair frame is absent from its full snapshot");
    assert.equal(
      replacement.case_sha256,
      original.case_sha256,
      "Reference repair changed project, media, or sampled frame inputs",
    );
    assert.notEqual(
      replacement.rgba_sha256,
      original.rgba_sha256,
      "Reference repair changes no pixels",
    );
    const review = ledger.self_reviews?.findLast(
      (review) =>
        review.case_id === repair.case_id &&
        review.frame === repair.frame &&
        review.profile === "gpu" &&
        review.reference_rgba_sha256 === original.rgba_sha256 &&
        review.candidate_rgba_sha256 === replacement.rgba_sha256,
    );
    assert(review, "Reference repair lacks self-review");
    assert.equal(review.verdict, "accepted", "Reference repair was not accepted");
    assert.equal(review.purpose, "deterministic-ts-oracle-repair");
    assert(
      ["float-precision", "decoder-rounding", "sampling-order", "shaping-hinting"].includes(
        review.residual_class,
      ),
      "Structural reference repairs are forbidden",
    );
    assert.equal(review.evidence?.report, repair.approval_review);
    const report = await reader.json(
      repair.approval_review,
      validSha(review.evidence.report_sha256),
    );
    for (const name of ["metrics", "ssim", "structural", "registration", "sequence"])
      assert.deepEqual(
        review[name],
        report.comparison[name],
        `Reference repair self-review ${name} differs`,
      );
    await auditComparisonEvidence(
      reader,
      {
        case_id: repair.case_id,
        frame: repair.frame,
        evidence: review.evidence,
        comparison: report.comparison,
      },
      "gpu",
      true,
      references,
      new Map([[key, replacement]]),
      catalogHash,
    );
    auditGpuChecks(report, catalog, original, repair.frame);
    effective.set(key, replacement);
    repairs.push({
      ...repair,
      run_id: snapshot.manifest.run_id,
      candidate_manifest_sha256: snapshot.manifestHash,
      path: replacement.path,
      reference_rgba_sha256: original.rgba_sha256,
      candidate_rgba_sha256: replacement.rgba_sha256,
    });
  }
  return { effective, repairs };
}

/** A second capture must be independent of every repaired frame's source capture. */
export async function assertRepairIndependence(reader, candidate, repairs) {
  for (const repair of repairs) {
    assert.notEqual(
      candidate.manifest.run_id,
      repair.run_id,
      "Candidate reuses the repair capture run",
    );
    const key = `${repair.case_id}/${repair.frame}`;
    const frame = candidate.requested.get(key);
    assert(frame, "Independent candidate repair frame is absent");
    assert.notEqual(
      await realpath(resolve(reader.root, frame.path)),
      await realpath(resolve(reader.root, repair.path)),
      "Candidate compares the repair file to itself",
    );
    assert.notEqual(
      posix.dirname(posix.dirname(posix.dirname(frame.path))),
      repair.directory,
      "Candidate reuses the repair capture directory",
    );
  }
}
