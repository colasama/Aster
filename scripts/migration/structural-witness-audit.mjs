import assert from "node:assert/strict";
import { dirname, relative, resolve, toNamespacedPath } from "node:path";
import { validateReport } from "../parity/pixel-gate.mjs";
import { PixelInputs } from "../parity/pixel-inputs.mjs";
import { reviewStatus } from "../parity/pixel-review.mjs";
import { auditUniformReference } from "./encoded-reference-domain.mjs";
import {
  assertEncodedStructuralAuthorization,
  encodedStructuralAlternatives,
  encodedStructuralPolicy,
} from "./encoded-structural-policy.mjs";
import { M0Evidence } from "./m0-evidence.mjs";
import { auditNv12Case, nv12CaseInputs } from "./native-nv12-case.mjs";

/** Reopen every stage against the export's source, frame inputs, binary and effective RGB oracle. */
export async function auditStructuralWitness(root, entry, execution, ledger) {
  const policy = assertEncodedStructuralAuthorization(ledger),
    reader = new M0Evidence(root);
  await reader.bytes(policy.proposal.path, policy.proposal.sha256);
  const witness = await reader.json(entry.structural_witness.path, entry.structural_witness.sha256);
  assert.equal(witness.kind, encodedStructuralPolicy);
  assert.equal(witness.source_unchanged, true);
  assert.equal(witness.execution_sha256, execution.source.execution_sha256);
  assert.equal(witness.case_id, entry.id);
  assert.deepEqual(witness.reference_binding, execution.reference_binding);
  assert.equal(
    resolve(root, witness.binary.path),
    resolve(root, execution.execution.native_binary),
  );
  const executable = execution.execution.binaries.find(
    (f) => resolve(root, f.path) === resolve(root, witness.binary.path),
  );
  assert.deepEqual(witness.binary, executable);
  await reader.bytes(witness.binary.path, witness.binary.sha256);
  const job = execution.assignments.find((a) => a.case.id === entry.id);
  assert(job);
  const pin = ledger.milestones.find((m) => m.id === "M3").input_manifest;
  assert.deepEqual(witness.input_manifest, pin);
  const manifest = await reader.json(pin.path, pin.sha256);
  const assignment = await nv12CaseInputs(
    reader,
    job.case,
    manifest.cases.find((c) => c.case_id === entry.id),
    dirname(pin.path).replaceAll("\\", "/"),
    manifest,
  );
  assert.deepEqual(witness.assignment, assignment);
  assert.deepEqual(
    (await reader.json(assignment.capture.path, assignment.capture.sha256)).inputs,
    job.inputs,
  );
  const conversion = await reader.json(witness.conversion.path, witness.conversion.sha256);
  assert.deepEqual(conversion.binary, witness.binary);
  const nv12 = await auditNv12Case(root, conversion, assignment, ledger);
  const rgb = await reader.json(witness.rgb.path, witness.rgb.sha256);
  assert.equal(rgb.inputs_unchanged, true);
  const inputs = new PixelInputs({ root, env: process.env });
  await reader.bytes(witness.rgb_manifest.path, witness.rgb_manifest.sha256);
  const entries = await inputs.load(resolve(root, witness.rgb_manifest.path), "diagnostic", null);
  const addresses = (values) => values.map((f) => f.frame).toSorted((a, b) => a - b);
  for (const group of [entries, rgb.frames, rgb.comparisons, witness.preencode])
    assert.deepEqual(
      addresses(group),
      job.case.frames.toSorted((a, b) => a - b),
    );
  const local = (path) =>
    relative(toNamespacedPath(root), toNamespacedPath(resolve(path))).replaceAll("\\", "/");
  const results = [];
  for (const candidate of entries) {
    assert.equal(candidate.case_id, entry.id);
    const frame = candidate.frame,
      rendered = conversion.frames.find((f) => f.frame === frame);
    assert.equal(resolve(candidate.path), resolve(root, rendered.png.path));
    assert.equal(candidate.png_sha256, rendered.png.sha256);
    const checked = rgb.frames.find((f) => f.frame === frame),
      record = rgb.comparisons.find((f) => f.frame === frame);
    assert.deepEqual(checked.evidence, record.evidence);
    const raw = await reader.json(record.evidence.report, record.evidence.report_sha256);
    assert.deepEqual(raw.comparison, record.comparison);
    validateReport(raw, await inputs.prepare(candidate), checked.step, inputs);
    const rgbReview = raw.comparison.passed
      ? await reviewStatus(inputs, candidate, raw)
      : { status: "failed" };
    const pre = witness.preencode.find((f) => f.frame === frame),
      encoded = entry.comparisons.find(
        (f) => f.name === "native" && f.index === frame - job.benchmark.startFrame,
      );
    assert.deepEqual(pre.encoded, { path: encoded.report, sha256: encoded.report_sha256 });
    const encodedRaw = await reader.json(encoded.report, encoded.report_sha256);
    const measured = await reader.json(pre.report.path, pre.report.sha256),
      c = measured.comparison;
    assert.deepEqual(measured.context, encodedRaw.context);
    for (const key of ["reference", "previous", "next"])
      assert.deepEqual(measured[key], encodedRaw[key]);
    assert.equal(
      local(measured.candidate.path),
      `${dirname(rendered.nv12.path).replaceAll("\\", "/")}/native.png`,
    );
    const pixels = [];
    for (const side of ["reference", "candidate"]) {
      const image = await reader.image(local(measured[side].path), measured[side].png_sha256);
      assert.equal(image.rgba_sha256, c[`${side}_rgba_sha256`]);
      assert.equal(image.width, job.case.size.width);
      assert.equal(image.height, job.case.size.height);
      pixels.push(image);
    }
    assert.equal(c.profile.catalog_sha256, inputs.catalogHash);
    assert.deepEqual(c.profile, encodedRaw.comparison.profile);
    assert.equal(pre.step.exit_code, c.passed ? 0 : 1);
    assert.equal(pre.step.command[0], resolve(root, witness.binary.path));
    if (c.registration.status === "uniform_reference_equivalence")
      auditUniformReference(measured, ...pixels);
    const alternatives = encodedStructuralAlternatives(c);
    const preNumeric = c.passed && alternatives?.length === 0;
    const preReview = preNumeric
      ? await reviewStatus(inputs, { case_id: entry.id, frame, profile: "yuv" }, measured)
      : { status: "failed" };
    const converted = nv12.frames.find((f) => f.frame === frame);
    const numeric = raw.comparison.passed && converted.numeric_passed && preNumeric;
    const reviewed = [rgbReview, converted.review, preReview].every((r) => r.status === "passed");
    results.push({
      frame,
      numeric_passed: numeric,
      reviewed,
      status: !numeric ? "failed" : reviewed ? "passed" : "awaiting-self-review",
      rgb_review: rgbReview,
      nv12_review: converted.review,
      preencode_review: preReview,
    });
  }
  assert.deepEqual(inputs.referenceBinding(), witness.reference_binding);
  await inputs.verifyStable();
  await reader.stable();
  return { witness: entry.structural_witness, frames: results };
}

/** Layered review is explicit and separate; historical failed flat comparisons remain rejected. */
export async function layeredFrameReview(reader, ledger, entry, frame, raw, witness, alternatives) {
  const review = ledger.self_reviews?.findLast(
    (r) =>
      r.purpose === encodedStructuralPolicy &&
      r.case_id === entry.id &&
      r.frame === frame &&
      r.evidence?.report ===
        entry.comparisons.find(
          (f) => f.name === "native" && f.index === frame - Math.min(...entry.frames),
        ).report &&
      r.layered_evidence?.witness?.sha256 === witness.sha256,
  );
  if (!review) return { status: "awaiting-self-review" };
  assert.deepEqual(review.layered_evidence, { witness, alternatives });
  assert.equal(review.profile, "yuv");
  const c = raw.comparison;
  for (const key of [
    "reference_rgba_sha256",
    "candidate_rgba_sha256",
    "metrics",
    "ssim",
    "structural",
    "registration",
    "sequence",
    "checks",
  ])
    assert.deepEqual(review[key], c[key]);
  const evidence = await reader.json(review.evidence.report, review.evidence.report_sha256);
  assert.deepEqual(evidence, raw);
  for (const name of ["contact_sheet", "heatmap"])
    await reader.bytes(review.evidence[name], review.evidence[`${name}_sha256`]);
  assert(["accepted", "rejected"].includes(review.verdict));
  return {
    status:
      review.verdict === "accepted" &&
      ["float-precision", "decoder-rounding", "sampling-order", "shaping-hinting"].includes(
        review.residual_class,
      )
        ? "passed"
        : "failed",
    evidence: review.evidence,
  };
}
