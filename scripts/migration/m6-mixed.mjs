import assert from "node:assert/strict";
import { posix } from "node:path";
import { reviewStatus } from "../parity/pixel-review.mjs";
import { validateCurrentStep } from "./m3-pixels.mjs";
import { auditMediaRejections, mediaLocal, mediaReceipts } from "./m6-media.mjs";

export async function auditMixedMedia(reader, group, report, ledger) {
  const pin = ledger.reference_baseline.native_media_frame;
  const manifest = await reader.json(pin.path, pin.sha256);
  const capture = await reader.json(manifest.capture.path, manifest.capture.sha256);
  assert.equal(capture.status, "passed");
  assert.deepEqual(manifest.gpu_info, capture.gpu_info);
  const gpu = manifest.gpu_info.gpuDevice.find((d) => d.active);
  assert(gpu && gpu.vendorId !== 5140);
  const ids = ["root-0", "root-1", "root-2", "recursive-0", "recursive-1", "recursive-2"];
  assert.deepEqual(
    manifest.frames.map((f) => f.id),
    ids,
  );
  assert.equal(group.frames.length, ids.length);
  const receipts = await mediaReceipts(reader, group.batch, report);
  assert.equal(receipts.length, ids.length);
  const jobs = await reader.json(
    mediaLocal(reader, group.batch.command[group.batch.command.indexOf("--batch") + 1]),
  );
  assert.equal(jobs.length, receipts.length);
  const tolerance = await reader.bytes("tests/parity/tolerances.json");
  for (const [i, frame] of manifest.frames.entries()) {
    const donor = capture.frames.find((f) => f.id === frame.id),
      actual = group.frames[i];
    assert(donor);
    assert.equal(frame.independent_device_exact, true);
    for (const field of ["plan", "replay", "reference"]) {
      assert.equal(frame[field].sha256, donor[field].sha256);
      await reader.bytes(frame[field].path, frame[field].sha256);
    }
    assert.deepEqual(frame.resources, donor.resources);
    for (const resource of frame.resources)
      await reader.bytes(
        `${posix.dirname(pin.path)}/resources/${resource.message.hash}.bin`,
        resource.sha256,
      );
    assert.deepEqual(frame.temporal, { passes: 1, samples: 8 });
    assert.equal(frame.surfaces, i < 3 ? 0 : 2);
    assert.equal(actual.case_id, `native-media-frame-${frame.mode}`);
    assert.equal(actual.frame, i % 3);
    assert.equal(mediaLocal(reader, jobs[i].plan), frame.plan.path);
    const receipt = receipts[i];
    assert.deepEqual(receipt, actual.receipt);
    assert.equal(receipt.plan_sha256, frame.plan.sha256);
    assert.equal(receipt.frame_index, i);
    assert.equal(receipt.renderer_reused, i > 0);
    assert.equal(receipt.native_gpu_execution, true);
    assert.equal(receipt.native_image_decode, true);
    assert.equal(receipt.native_images.length, 2);
    assert.equal(receipt.native_videos.length, 1);
    assert.equal(receipt.native_videos[0].frame_index, i % 3 === 1 ? 23 : 11);
    assert.equal(receipt.adapter.vendor, gpu.vendorId);
    assert.equal(receipt.adapter.device, gpu.deviceId);
    assert.notEqual(receipt.adapter.device_type, "Cpu");
    assert.equal(receipt.temporal_cache.passes, 1);
    assert.equal(receipt.temporal_cache.samples, 8);
    const image = await reader.image(actual.output.path, actual.output.sha256);
    assert.equal(receipt.output, jobs[i].out);
    assert.equal(mediaLocal(reader, receipt.output), actual.output.path);
    assert.equal(receipt.rgba_sha256, image.rgba_sha256);
    validateCurrentStep(actual.step, report.started_at);
    const raw = await reader.json(actual.evidence);
    assert.deepEqual(raw.comparison, actual.comparison);
    assert.equal(raw.context.case_id, actual.case_id);
    assert.equal(raw.comparison.profile.name, "decode");
    assert.equal(raw.comparison.profile.catalog_sha256, tolerance.sha256);
    assert.equal(raw.comparison.reference_rgba_sha256, frame.reference.rgba_sha256);
    assert.equal(raw.comparison.candidate_rgba_sha256, image.rgba_sha256);
    assert(raw.comparison.passed && raw.comparison.checks.every((c) => c.passed));
    assert.equal(raw.comparison.checks.length, 9);
    const status = await reviewStatus(
      { context: { root: reader.root }, ledger, bytes: (p) => reader.bytes(mediaLocal(reader, p)) },
      { case_id: actual.case_id, frame: actual.frame, profile: "decode" },
      raw,
    );
    assert.equal(status.status, "passed");
  }
  await auditMediaRejections(reader, group.controls, ["root", "recursive"], report);
  for (const tool of group.tools) await reader.bytes(tool.path, tool.sha256);
  return { frames: receipts.length, supplied_file_pixel_rejections: group.controls.length };
}
