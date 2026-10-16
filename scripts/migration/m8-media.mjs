import assert from "node:assert/strict";
import { posix } from "node:path";
import { reviewStatus } from "../parity/pixel-review.mjs";
import { validateCurrentStep } from "./m3-pixels.mjs";
import { auditMediaRejections, mediaLocal, mediaReceipts } from "./m6-media.mjs";

/** Untagged inputs use their independent TS capture, with the same decode oracle and self-review. */
export async function auditM8UntaggedMedia(reader, group, report, ledger) {
  assert.equal(group.status, "passed");
  assert.equal(group.source.source_sha256, report.source.source_sha256);
  for (const step of group.steps) validateCurrentStep(step, report.started_at);
  for (const field of ["color_primaries", "color_transfer", "color_space"])
    assert([undefined, "unknown"].includes(group.video[field]));
  const capture = await reader.json(group.reference.path, group.reference.sha256);
  assert.equal(capture.status, "passed");
  assert.equal(capture.source.source_sha256, report.source.source_sha256);
  assert.deepEqual(
    capture.frames.map((f) => f.id),
    ["root-0", "root-1", "root-2", "recursive-0", "recursive-1", "recursive-2"],
  );
  const pixels = group.pixels;
  assert.equal(pixels.status, "passed");
  assert.equal(pixels.frames.length, 6);
  const receipts = await mediaReceipts(reader, pixels.batch, report);
  assert.equal(receipts.length, 6);
  const tolerance = await reader.bytes("tests/parity/tolerances.json");
  for (const [index, actual] of pixels.frames.entries()) {
    const reference = capture.frames[index];
    assert.equal(reference.independent_device_exact, true);
    for (const file of [reference.plan, reference.replay])
      await reader.bytes(file.path, file.sha256);
    for (const file of reference.resources)
      await reader.bytes(
        `${posix.dirname(group.reference.path)}/resources/${file.message.hash}.bin`,
        file.sha256,
      );
    const before = await reader.image(reference.reference.path, reference.reference.sha256);
    const after = await reader.image(actual.output.path, actual.output.sha256);
    assert.deepEqual(actual.receipt, receipts[index]);
    assert.equal(actual.receipt.plan_sha256, reference.plan.sha256);
    assert.equal(actual.receipt.rgba_sha256, after.rgba_sha256);
    assert.equal(actual.receipt.native_gpu_execution, true);
    assert.equal(
      actual.receipt.native_videos[0].color_interpretation,
      "untagged SD: SMPTE 170M limited",
    );
    validateCurrentStep(actual.step, report.started_at);
    assert.equal(actual.case_id, `native-untagged-media-frame-${reference.mode}`);
    assert.equal(actual.frame, index % 3);
    const raw = await reader.json(actual.evidence);
    assert.deepEqual(raw.comparison, actual.comparison);
    assert.equal(raw.context.case_id, actual.case_id);
    assert.equal(raw.comparison.profile.name, "decode");
    assert.equal(raw.comparison.profile.catalog_sha256, tolerance.sha256);
    assert.equal(raw.comparison.reference_rgba_sha256, before.rgba_sha256);
    assert.equal(raw.comparison.candidate_rgba_sha256, after.rgba_sha256);
    assert(raw.comparison.passed && raw.comparison.checks.every((c) => c.passed));
    assert.equal(raw.comparison.checks.length, 9);
    const review = await reviewStatus(
      {
        context: { root: reader.root },
        ledger,
        bytes: (path) => reader.bytes(mediaLocal(reader, path)),
      },
      { case_id: actual.case_id, frame: actual.frame, profile: "decode" },
      raw,
    );
    assert.equal(review.status, "passed");
  }
  await auditMediaRejections(reader, pixels.controls, ["root", "recursive"], report);
  for (const file of pixels.tools) await reader.bytes(file.path, file.sha256);
  return { status: "passed", frames: 6 };
}
