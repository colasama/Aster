import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { containedPath } from "./pixel-inputs.mjs";
import { decodeRgbaPng } from "./png.mjs";

export async function reviewStatus(inputs, entry, report) {
  const comparison = report.comparison;
  if (entry.profile === "exact") return { status: "passed", self_review_required: false };
  const review = inputs.ledger.self_reviews?.findLast(
    (review) =>
      review.case_id === entry.case_id &&
      review.frame === entry.frame &&
      review.profile === entry.profile &&
      review.reference_rgba_sha256 === comparison.reference_rgba_sha256 &&
      review.candidate_rgba_sha256 === comparison.candidate_rgba_sha256,
  );
  if (!review)
    return {
      status: "incomplete",
      self_review_required: true,
      reason: "The matching pixel result requires section 6.6 self-review",
    };
  if (review.verdict === "rejected")
    return {
      status: "failed",
      self_review_required: true,
      reason: "The matching pixel result was rejected during self-review",
    };
  assert.equal(review.verdict, "accepted", "Unknown self-review verdict");
  assert(
    ["float-precision", "decoder-rounding", "sampling-order", "shaping-hinting"].includes(
      review.residual_class,
    ),
    "An accepted self-review must have a non-structural residual class",
  );
  for (const field of ["metrics", "ssim", "structural", "registration", "sequence"]) {
    assert(
      isDeepStrictEqual(review[field], comparison[field]),
      `Self-review ${field} does not match this comparison`,
    );
  }
  const evidencePath = containedPath(inputs.context.root, review.evidence?.report);
  const evidence = await inputs.bytes(evidencePath);
  const reportHash = review.evidence?.report_sha256 ?? review.report_sha256;
  assert(/^[a-f0-9]{64}$/.test(reportHash), "Self-review report SHA-256 is required");
  assert.equal(evidence.sha256, reportHash, "Self-review report SHA-256 differs");
  const evidenceReport = JSON.parse(evidence.bytes.toString("utf8"));
  assert.equal(
    evidenceReport.comparison?.passed,
    true,
    "Self-review evidence did not pass the comparison",
  );
  assert.equal(evidenceReport.comparison.profile.name, entry.profile);
  assert.equal(evidenceReport.comparison.profile.catalog_sha256, comparison.profile.catalog_sha256);
  assert.equal(evidenceReport.context?.case_id, entry.case_id);
  assert.equal(evidenceReport.comparison.reference_rgba_sha256, comparison.reference_rgba_sha256);
  assert.equal(evidenceReport.comparison.candidate_rgba_sha256, comparison.candidate_rgba_sha256);
  assert.equal(evidenceReport.comparison.width, comparison.width);
  assert.equal(evidenceReport.comparison.height, comparison.height);
  for (const field of ["metrics", "ssim", "structural", "registration", "sequence"]) {
    assert(
      isDeepStrictEqual(evidenceReport.comparison[field], comparison[field]),
      `Self-review evidence ${field} differs`,
    );
  }
  for (const name of ["heatmap", "contact_sheet"]) {
    const path = containedPath(inputs.context.root, review.evidence?.[name]);
    assert.equal(
      path,
      join(dirname(evidencePath), name === "heatmap" ? "heatmap.png" : "contact-sheet.png"),
      "Self-review images must belong to the comparison report directory",
    );
    const image = await inputs.bytes(path);
    const expected = review.evidence?.[`${name}_sha256`] ?? review[`${name}_sha256`];
    assert(/^[a-f0-9]{64}$/.test(expected), `Self-review ${name} SHA-256 is required`);
    assert.equal(image.sha256, expected, `Self-review ${name} SHA-256 differs`);
    const decoded = decodeRgbaPng(image.bytes);
    const scale = name === "heatmap" ? 1 : 2;
    assert.equal(decoded.width, comparison.width * scale, "Self-review image width differs");
    assert.equal(decoded.height, comparison.height * scale, "Self-review image height differs");
  }
  return { status: "passed", self_review_required: true, self_review: review.evidence };
}
