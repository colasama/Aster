import assert from "node:assert/strict";
import { dirname, posix } from "node:path";
import { stableSource, validSha } from "./m0-evidence.mjs";

export async function auditComparison(
  reader,
  gate,
  profile,
  passed,
  references,
  candidates,
  catalogHash,
) {
  assert.equal(gate.id, "G3");
  assert.equal(gate.status, passed ? "passed" : "failed");
  assert.equal(gate.inputs_unchanged, true);
  assert.equal(gate.frames.length, candidates.size);
  assert.equal(gate.comparisons.length, candidates.size);
  assert.deepEqual(
    gate.evidence,
    gate.comparisons.map((item) => item.evidence),
  );
  const records = new Map(gate.comparisons.map((item) => [`${item.case_id}/${item.frame}`, item]));
  assert.equal(records.size, candidates.size, "Comparison records are duplicated");
  const seen = new Set();
  const reports = new Map();
  for (const frame of gate.frames) {
    const key = `${frame.case_id}/${frame.frame}`;
    const reference = references.get(key);
    const candidate = candidates.get(key);
    const record = records.get(key);
    assert(
      reference && candidate && record && !seen.has(key),
      "Pixel coverage is incomplete or duplicated",
    );
    seen.add(key);
    assert.equal(frame.profile, profile);
    assert.equal(frame.status, passed ? "passed" : "failed");
    assert.equal(frame.self_review_required, profile !== "exact");
    assert.equal(frame.step.exit_code, passed ? 0 : 1);
    assert.equal(frame.step.status, passed ? "passed" : "failed");
    assert(
      !frame.step.error && !frame.step.signal,
      "Comparison process failed outside pixel checks",
    );
    assert.deepEqual(frame.evidence, record.evidence);
    reports.set(
      key,
      await auditComparisonEvidence(
        reader,
        record,
        profile,
        passed,
        references,
        candidates,
        catalogHash,
      ),
    );
  }
  return reports;
}

/** Audit stored comparison evidence without inventing a process or gate execution. */
export async function auditComparisonEvidence(
  reader,
  record,
  profile,
  passed,
  references,
  candidates,
  catalogHash,
) {
  const frame = record;
  const key = `${frame.case_id}/${frame.frame}`;
  const reference = references.get(key);
  const candidate = candidates.get(key);
  assert(reference && candidate, "Comparison inputs are absent");
  const evidence = record.evidence;
  const report = await reader.json(evidence.report, validSha(evidence.report_sha256));
  assert.equal(report.schema_version, 1);
  assert.deepEqual(report.comparison, record.comparison);
  const comparison = report.comparison;
  assert.equal(comparison.schema_version, 1);
  assert.equal(comparison.passed, passed);
  assert.equal(comparison.self_review_required, profile !== "exact");
  assert.equal(comparison.profile.name, profile);
  assert.equal(comparison.profile.catalog_sha256, catalogHash);
  assert.equal(report.context.case_id, frame.case_id);
  assert.equal(
    Boolean(report.context.sequence),
    reference.sequence,
    "Sequence evidence was omitted or invented",
  );
  assert.equal(report.context.isolated, reference.isolated);
  assert.equal(comparison.isolated, reference.isolated);
  assert.equal(comparison.width, reference.width);
  assert.equal(comparison.height, reference.height);
  assert.equal(report.reference.png_sha256, reference.png_sha256);
  assert.equal(report.candidate.png_sha256, candidate.png_sha256);
  assert.equal(comparison.reference_rgba_sha256, reference.rgba_sha256);
  assert.equal(comparison.candidate_rgba_sha256, candidate.rgba_sha256);
  assert.equal(comparison.metrics.pixel_count, reference.width * reference.height);
  const checks = comparison.checks;
  assert(
    Array.isArray(checks) &&
      checks.length &&
      new Set(checks.map((item) => item.id)).size === checks.length,
  );
  assert(checks.every((item) => typeof item.passed === "boolean"));
  assert.equal(
    checks.every((item) => item.passed),
    passed,
  );
  if (profile === "exact") {
    assert.equal(
      reference.rgba_sha256,
      candidate.rgba_sha256,
      "Actual candidate RGBA differs from the reference",
    );
    assert.equal(comparison.metrics.exact, true);
    for (const name of [
      "max_abs_channel_error",
      "mean_abs_error",
      "mean_squared_error",
      "rgb_mean_squared_error",
      "pixels_above_tolerance",
    ])
      assert.equal(comparison.metrics[name], 0);
    assert.deepEqual(
      checks.map((item) => item.id).sort(),
      report.context.sequence ? ["exact_rgba", "frame_identity"] : ["exact_rgba"],
    );
  }
  if (report.context.sequence) {
    assert.equal(report.context.sequence.frame, frame.frame);
    for (const field of ["first_frame", "last_frame"])
      assert.equal(report.context.sequence[field], reference.sequenceDomain[field]);
    assert.equal(comparison.sequence?.passed, true);
    for (const [name, index] of [
      ["previous", frame.frame - 1],
      ["next", frame.frame + 1],
    ]) {
      const neighbor = references.get(`${frame.case_id}/${index}`);
      assert.equal(
        report[name]?.png_sha256 ?? null,
        neighbor?.png_sha256 ?? null,
        "Sequence neighbor evidence differs",
      );
      if (neighbor && profile === "exact")
        assert.notEqual(
          neighbor.rgba_sha256,
          candidate.rgba_sha256,
          "Equal neighboring pixels cannot prove frame identity",
        );
    }
  } else assert.equal(comparison.sequence, null);
  for (const [name, file, scale] of [
    ["heatmap", "heatmap.png", 1],
    ["contact_sheet", "contact-sheet.png", 2],
  ]) {
    assert.equal(evidence[name], posix.join(dirname(evidence.report).replaceAll("\\", "/"), file));
    const { bytes } = await reader.bytes(evidence[name], validSha(evidence[`${name}_sha256`]));
    assert(
      bytes.length >= 24 &&
        bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])),
      "Comparison artifact is not PNG",
    );
    assert.equal(bytes.readUInt32BE(16), reference.width * scale);
    assert.equal(bytes.readUInt32BE(20), reference.height * scale);
  }
  return report;
}

export async function auditOracle(reader, ledger, task, references, catalogHash) {
  const path = task.oracle_rejection.report;
  const proof = await reader.json(path);
  assert.equal(proof.status, "passed");
  assert.equal(proof.source_unchanged, true);
  stableSource(proof.source, proof.source_after, "source_sha256");
  assert.deepEqual(proof.perturbation, {
    case_id: "shape-ellipse",
    frame: 0,
    rectangle: [145, 70, 20, 20],
    changed_pixels: 400,
    replacement_rgba: [0, 0, 0, 0],
  });
  const directory = path.slice(0, path.lastIndexOf("/"));
  const reference = references.get("shape-ellipse/0");
  assert(reference, "The deliberate oracle case is absent");
  const original = await reader.image(reference.path, reference.png_sha256);
  const artifacts = {};
  for (const [side, profile, passed] of [
    ["positive", "exact", true],
    ["negative", "gpu", false],
  ]) {
    const manifest = await reader.json(`${directory}/${side}.json`);
    assert.equal(manifest.schema_version, 1);
    assert.equal(manifest.frames.length, 1);
    const entry = manifest.frames[0];
    assert.equal(entry.case_id, "shape-ellipse");
    assert.equal(entry.frame, 0);
    const candidate = await reader.image(`${directory}/${entry.path}`, validSha(entry.png_sha256));
    assert.equal(candidate.width, original.width);
    assert.equal(candidate.height, original.height);
    if (passed) assert(original.pixels.equals(candidate.pixels));
    else {
      const expected = Buffer.from(original.pixels);
      let changed = 0;
      for (let y = 70; y < 90; y++)
        for (let x = 145; x < 165; x++) {
          const offset = (y * original.width + x) * 4;
          if (expected.subarray(offset, offset + 4).some((value) => value !== 0)) changed++;
          expected.fill(0, offset, offset + 4);
        }
      assert.equal(changed, 400);
      assert(
        expected.equals(candidate.pixels),
        "The rejection candidate is not the recorded deliberate perturbation",
      );
    }
    assert.equal(proof[side].scope, "diagnostic");
    assert.equal(proof[side].full_coverage, false);
    assert.deepEqual(await reader.json(`${directory}/${side}-g3.json`), proof[side]);
    artifacts[side] = (
      await auditComparison(
        reader,
        proof[side],
        profile,
        passed,
        references,
        new Map([["shape-ellipse/0", candidate]]),
        catalogHash,
      )
    ).get("shape-ellipse/0");
  }
  const negative = artifacts.negative.comparison;
  assert.equal(negative.metrics.exact, false);
  assert.equal(negative.structural.largest_error_component, 400);
  assert.equal(negative.structural.alpha_changed_pixels, 400);
  for (const id of ["error_clusters", "alpha_coverage"])
    assert(negative.checks.some((item) => item.id === id && item.passed === false));
  const review = ledger.self_reviews.findLast(
    (item) =>
      item.purpose === "oracle-rejection-proof" &&
      item.case_id === "shape-ellipse" &&
      item.frame === 0 &&
      item.profile === "gpu" &&
      item.reference_rgba_sha256 === negative.reference_rgba_sha256 &&
      item.candidate_rgba_sha256 === negative.candidate_rgba_sha256,
  );
  assert(review, "The deliberate rejection lacks the agent's self-review");
  assert.equal(review.verdict, "rejected");
  assert.equal(review.residual_class, "structural");
  for (const field of ["metrics", "ssim", "structural", "registration", "sequence"])
    assert.deepEqual(review[field], negative[field]);
  assert.deepEqual(review.evidence, proof.negative.comparisons[0].evidence);
  assert.deepEqual(task.oracle_rejection.comparison_evidence, review.evidence);
  return {
    status: "passed",
    report: path,
    changed_pixels: 400,
    positive: "passed",
    negative: "failed",
    self_review: "rejected",
  };
}
