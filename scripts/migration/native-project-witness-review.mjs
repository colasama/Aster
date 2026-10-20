import assert from "node:assert/strict";
import { dirname, join, relative, resolve } from "node:path";
import { validateReport } from "../parity/pixel-gate.mjs";
import { PixelInputs } from "../parity/pixel-inputs.mjs";
import { reviewStatus } from "../parity/pixel-review.mjs";
import { auditUniformReference } from "./encoded-reference-domain.mjs";
import {
  assertEncodedStructuralAuthorization,
  encodedStructuralPolicy,
} from "./encoded-structural-policy.mjs";
import { M0Evidence } from "./m0-evidence.mjs";
import { nv12PlaneComparison } from "./native-nv12-case.mjs";
import { auditProjectExportEvidence } from "./native-project-export-evidence.mjs";
import { projectPixelEntries } from "./native-project-pixel-inputs.mjs";

/** Each stage remains independently checked and reviewed before an encoded structural alternative. */
export async function auditProjectStructuralWitness(
  root,
  entry,
  execution,
  ledger,
  referenceInputs,
) {
  const reader = new M0Evidence(root),
    policy = assertEncodedStructuralAuthorization(ledger);
  await reader.bytes(policy.proposal.path, policy.proposal.sha256);
  const witness = await reader.json(entry.structural_witness.path, entry.structural_witness.sha256);
  assert.equal(witness.kind, encodedStructuralPolicy);
  assert.equal(witness.input_kind, "native-project-export");
  assert.equal(witness.execution_sha256, execution.source.execution_sha256);
  assert.equal(witness.source_unchanged, true);
  assert.equal(witness.case_id, entry.id);
  assert.deepEqual(witness.reference_binding, execution.reference_binding);
  const job = execution.assignments.find((value) => value.case.id === entry.id);
  assert(job);
  const original = await auditProjectExportEvidence(root, execution.execution, job);
  assert.deepEqual(witness.export_witness, original.binding);
  const native = original.witness;
  assert.deepEqual(
    witness.binary,
    execution.execution.binaries.find((file) => file.path === execution.execution.native_binary),
  );
  for (const file of [witness.binary, witness.ffmpeg]) await reader.bytes(file.path, file.sha256);
  const local = (path) =>
    relative(root, resolve(root, path.replace(/^\\\\\?\\/, ""))).replaceAll("\\", "/");
  const inputs = referenceInputs ?? new PixelInputs({ root, env: process.env });
  if (!referenceInputs) await inputs.loadReferenceCatalog();
  assert.deepEqual(inputs.ledger.reference_repairs, ledger.reference_repairs);
  assert.deepEqual(inputs.ledger.self_reviews, ledger.self_reviews);
  await reader.bytes(witness.rgb_manifest.path, witness.rgb_manifest.sha256);
  const candidates = await projectPixelEntries(root, witness.rgb_manifest.path, inputs);
  const rgb = await reader.json(witness.rgb.path, witness.rgb.sha256);
  assert.equal(rgb.inputs_unchanged, true);
  for (const group of [candidates, rgb.frames, rgb.comparisons, witness.frames])
    assert.deepEqual(
      group.map((frame) => frame.frame),
      job.case.frames.toSorted((a, b) => a - b),
    );
  const results = [];
  for (const [index, candidate] of candidates.entries()) {
    const frame = candidate.frame,
      stage = witness.frames[index],
      captured = native.frames[index];
    assert.equal(frame, job.benchmark.startFrame + captured.index);
    const directory = join(root, dirname(original.binding.path), String(captured.index));
    assert.equal(resolve(candidate.path), join(directory, "candidate.png"));
    assert.equal(candidate.png_sha256, captured.rgb.png_sha256);
    const checked = rgb.frames[index],
      record = rgb.comparisons[index];
    assert.deepEqual(checked.evidence, record.evidence);
    const raw = await reader.json(record.evidence.report, record.evidence.report_sha256);
    assert.deepEqual(raw.comparison, record.comparison);
    validateReport(raw, await inputs.prepare(candidate), checked.step, inputs);
    const rgbReview = raw.comparison.passed
      ? await reviewStatus(inputs, candidate, raw)
      : { status: "failed" };
    assert.equal(stage.nv12.path, local(join(directory, "input.nv12")));
    assert.equal(stage.nv12.sha256, captured.nv12_sha256);
    const actual = await reader.bytes(stage.nv12.path, stage.nv12.sha256);
    const reference = await reader.bytes(stage.reference.path, stage.reference.sha256);
    const planes = nv12PlaneComparison(reference.bytes, actual.bytes, job.case.size);
    assert.deepEqual(planes, stage.planes);
    const encoded = entry.comparisons.find(
      (value) => value.name === "native" && value.index === captured.index,
    );
    assert(encoded);
    assert.deepEqual(stage.encoded, { path: encoded.report, sha256: encoded.report_sha256 });
    const encodedRaw = await reader.json(encoded.report, encoded.report_sha256);
    const reviews = [];
    let numeric = raw.comparison.passed && planes.every((plane) => plane.passed);
    for (const name of ["conversion", "preencode"]) {
      const saved = stage[name],
        measured = await reader.json(saved.report.path, saved.report.sha256),
        c = measured.comparison;
      const expectedContext =
        name === "conversion"
          ? {
              case_id: `nv12-conversion-${entry.id}`,
              isolated: false,
              background: null,
              sequence: null,
              g5_uniform_reference: true,
            }
          : encodedRaw.context;
      assert.deepEqual(measured.context, expectedContext);
      assert.equal(saved.step.command[0], resolve(root, witness.binary.path));
      assert.equal(
        local(measured.candidate.path),
        `${dirname(stage.reference.path).replaceAll("\\", "/")}/native.png`,
      );
      if (name === "conversion")
        assert.equal(
          local(measured.reference.path),
          `${dirname(stage.reference.path).replaceAll("\\", "/")}/reference.png`,
        );
      else
        for (const key of ["reference", "previous", "next"])
          assert.deepEqual(measured[key], encodedRaw[key]);
      const images = [];
      for (const side of ["reference", "candidate"]) {
        const image = await reader.image(local(measured[side].path), measured[side].png_sha256);
        assert.equal(image.rgba_sha256, c[`${side}_rgba_sha256`]);
        assert.equal(image.width, job.case.size.width);
        assert.equal(image.height, job.case.size.height);
        images.push(image);
      }
      const compareEntry = {
        case_id: expectedContext.case_id,
        frame,
        profile: "yuv",
        item: { size: job.case.size },
        png_sha256: measured.candidate.png_sha256,
      };
      validateReport(
        measured,
        {
          entry: compareEntry,
          reference: {
            png_sha256: measured.reference.png_sha256,
            meta: { rgba_sha256: images[0].rgba_sha256 },
          },
          context: expectedContext,
          neighbors: { previous: measured.previous, next: measured.next },
        },
        saved.step,
        inputs,
      );
      if (c.registration.status === "uniform_reference_equivalence")
        auditUniformReference(measured, ...images);
      numeric &&= c.passed;
      reviews.push(
        c.passed ? await reviewStatus(inputs, compareEntry, measured) : { status: "failed" },
      );
    }
    const reviewed = [rgbReview, ...reviews].every((value) => value.status === "passed");
    results.push({
      frame,
      numeric_passed: numeric,
      reviewed,
      status: !numeric ? "failed" : reviewed ? "passed" : "awaiting-self-review",
      rgb_review: rgbReview,
      nv12_review: reviews[0],
      preencode_review: reviews[1],
    });
  }
  assert.deepEqual(inputs.referenceBinding(), witness.reference_binding);
  await inputs.verifyStable();
  await reader.stable();
  return { witness: entry.structural_witness, frames: results };
}
