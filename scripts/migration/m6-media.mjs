import assert from "node:assert/strict";
import { readdir, stat } from "node:fs/promises";
import { join, relative, toNamespacedPath } from "node:path";
import { validateReport } from "../parity/pixel-gate.mjs";
import { PixelInputs } from "../parity/pixel-inputs.mjs";
import { reviewStatus } from "../parity/pixel-review.mjs";
import { validateCurrentStep } from "./m3-pixels.mjs";
import { validateNativeReceipt } from "./native-core-gate.mjs";

export const mediaLocal = (reader, path) =>
  relative(toNamespacedPath(reader.root), toNamespacedPath(path)).replaceAll("\\", "/");

export async function mediaReceipts(reader, step, report) {
  validateCurrentStep(step, report.started_at);
  assert.equal(
    step.command[0],
    join(reader.root, report.gates.find((g) => g.id === "G3").binary.path),
  );
  return (await reader.bytes(step.log)).bytes
    .toString("utf8")
    .split(/\r?\n/)
    .filter((line) => line.startsWith('{"schema_version":'))
    .map((line) => JSON.parse(line));
}

export async function auditMediaRejections(reader, controls, ids, report) {
  assert.deepEqual(
    controls.map((c) => c.id),
    ids,
  );
  for (const control of controls) {
    assert.equal(control.rejected, true);
    validateCurrentStep(control.step, report.started_at, true);
    const log = (await reader.bytes(control.step.log)).bytes.toString("utf8");
    const error = JSON.parse(log.trim().split(/\r?\n/).at(-1)).error;
    assert.equal(typeof error, "string");
    assert(error.length > 0);
    if (control.error) assert.equal(error, control.error);
    const out = control.step.command[control.step.command.indexOf("--out") + 1];
    assert(mediaLocal(reader, out).startsWith("artifacts/migration/"));
    await assert.rejects(stat(out), { code: "ENOENT" });
  }
}

/** Validate real presentation identities and comparison evidence, not summary success flags. */
export async function auditTimedMedia(reader, group, selected, report, base, video) {
  const profile = video ? "decode" : "gpu";
  const inputs = new PixelInputs({ root: reader.root, env: process.env });
  await reader.bytes(group.candidate_manifest.path, group.candidate_manifest.sha256);
  const entries = await inputs.load(
    join(reader.root, group.candidate_manifest.path),
    "diagnostic",
    profile,
  );
  const keys = (items) => items.map((f) => `${f.case_id}:${f.frame}`).sort();
  const required = selected.cases.flatMap((c) =>
    c.frames.map((frame) => ({ case_id: c.id, frame })),
  );
  for (const frames of [entries, group.frames, group.pixels.frames, group.pixels.comparisons])
    assert.deepEqual(keys(frames), keys(required));
  assert.equal(group.pixels.status, "passed");
  assert.equal(group.pixels.inputs_unchanged, true);
  const receipts = await mediaReceipts(reader, group.batch.step, report);
  assert.equal(receipts.length, required.length * (video ? 1 : 2));
  const jobs = await reader.json(
    mediaLocal(reader, group.batch.step.command[group.batch.step.command.indexOf("--batch") + 1]),
  );
  assert.equal(jobs.length, receipts.length);
  const catalog = await reader.json("tests/parity/assets/media-assets.json");
  for (const [i, frame] of group.frames.entries()) {
    const entry = entries.find((e) => e.case_id === frame.case_id && e.frame === frame.frame);
    const checked = group.pixels.frames.find(
      (e) => e.case_id === frame.case_id && e.frame === frame.frame,
    );
    const compared = group.pixels.comparisons.find(
      (e) => e.case_id === frame.case_id && e.frame === frame.frame,
    );
    assert.equal(frame.input.path, `${base}/${frame.case_id}/${frame.frame}/plan.fpln`);
    const plan = await reader.bytes(frame.input.path, frame.input.sha256);
    assert.equal(mediaLocal(reader, jobs[i].plan), frame.input.path);
    const metadata = JSON.parse(plan.bytes.subarray(32, 32 + plan.bytes.readUInt32LE(8)));
    assert.deepEqual(metadata.slices[0].media_pixels, []);
    const messages = await reader.json(mediaLocal(reader, jobs[i].resource_manifest));
    assert.deepEqual(messages.map((m) => m.hash).sort(), metadata.resources);
    const source = messages.find((m) => m.kind === "media_source"),
      media = messages.find((m) => m.kind === "media_frame");
    for (const m of messages)
      await reader.bytes(`${base}/${frame.case_id}/frame-resources/${m.hash}.bin`);
    const rate = frame.case_id.includes("24000") ? 24000 : 30000;
    const asset =
      catalog.assets[
        video
          ? `barcode-${rate}-1001.mp4`
          : `sequence-${String(media.descriptor.sample.frame).padStart(4, "0")}.png`
      ];
    assert.equal(frame.grant.source, source.hash);
    assert.equal(frame.grant.scope, source.descriptor.authorization_scope);
    assert.equal(frame.grant.sha256, asset.sha256);
    await reader.bytes(mediaLocal(reader, frame.grant.path), asset.sha256);
    const pixels = await reader.image(frame.output.path, frame.output.sha256);
    assert.equal(mediaLocal(reader, entry.path), frame.output.path);
    assert.equal(frame.receipt.output, jobs[i].out);
    assert.deepEqual(receipts[i], frame.receipt);
    const meta = await reader.json(`${base}/${frame.case_id}/${frame.frame}/meta.json`);
    validateNativeReceipt(frame.receipt, {
      plan_sha256: plan.sha256,
      rgba_sha256: pixels.rgba_sha256,
      ...entry.item.size,
      adapter: meta.adapter.gpuMemory.device,
    });
    assert.equal(frame.receipt.frame_index, i);
    assert.equal(frame.receipt.renderer_reused, i > 0);
    assert.equal(frame.receipt.native_image_decode, true);
    assert.equal(frame.receipt.native_images.length, 1);
    const image = frame.receipt.native_images[0];
    assert.equal(image.frame, media.hash);
    assert.equal(image.source, source.hash);
    assert.equal(image.source_sha256, asset.sha256);
    assert.equal(
      image.backend,
      video
        ? "ffmpeg-video-snapshot"
        : process.platform === "win32"
          ? "windows-wic-png-snapshot"
          : "ffmpeg-sequence-snapshot",
    );
    if (video) {
      assert.equal(frame.receipt.native_videos.length, 1);
      const v = frame.receipt.native_videos[0];
      assert.equal(v.frame, media.hash);
      assert.equal(v.frame_index, frame.frame);
      assert.equal(v.presentation_timestamp, frame.frame * 1001);
      assert.equal(v.duration, 1001);
      assert.deepEqual(v.timebase, { numerator: 1, denominator: rate });
      for (const key of ["requested_time", "uploaded_time"])
        assert.deepEqual(v[key], media.descriptor.sample[key]);
      assert.deepEqual(v.color, {
        primaries: "bt709",
        transfer: "bt709",
        matrix: "bt709",
        fullRange: false,
      });
      assert.equal(v.source_pixel_format, "yuv420p");
      assert.equal(v.measured_interop, "cpu_copy");
    } else {
      assert.equal(frame.member, media.descriptor.sample.frame);
      assert.equal(frame.grant.sequence_frame, frame.member);
      const reverse = receipts[receipts.length - i - 1];
      assert.equal(reverse.plan_sha256, plan.sha256);
      assert.deepEqual(reverse.native_images, frame.receipt.native_images);
      assert.equal(
        (await reader.image(mediaLocal(reader, reverse.output))).rgba_sha256,
        pixels.rgba_sha256,
      );
    }
    validateCurrentStep(checked.step, report.started_at);
    assert.equal(checked.status, "passed");
    assert.equal(checked.profile, profile);
    assert.deepEqual(checked.evidence, compared.evidence);
    const raw = await reader.json(compared.evidence.report, compared.evidence.report_sha256);
    assert.deepEqual(raw.comparison, compared.comparison);
    assert.equal(raw.comparison.candidate_rgba_sha256, pixels.rgba_sha256);
    validateReport(raw, await inputs.prepare(entry), checked.step, inputs);
    assert.equal((await reviewStatus(inputs, entry, raw)).status, "passed");
  }
  assert.deepEqual(group.pixels.reference_binding, inputs.referenceBinding());
  for (const tool of [group.ffmpeg, group.ffprobe].filter(Boolean))
    await reader.bytes(tool.path, tool.sha256);
  const ids = ["missing-grant", "wrong-scope", "wrong-sha", "source-budget", "pixel-budget"];
  await auditMediaRejections(
    reader,
    group.rejections,
    [
      ...ids,
      ...(video
        ? ["video-index-budget", "video-timeout"]
        : ["wrong-member", "unscoped-member", "wrong-member-bytes"]),
    ],
    report,
  );
  if (video) {
    await auditMediaRejections(
      reader,
      group.timing_controls.slice(0, 2),
      ["timestamp-mismatch", "outside-duration"],
      report,
    );
    const control = group.timing_controls[2];
    assert.equal(control.id, "neighbor-frame");
    await mediaReceipts(reader, control.step, report);
    assert.equal(control.pixel_gate.status, "failed");
    const failure = control.pixel_gate.comparisons[0];
    const raw = await reader.json(failure.evidence.report, failure.evidence.report_sha256);
    assert.deepEqual(raw.comparison, failure.comparison);
    assert.equal(raw.comparison.sequence.passed, false);
    validateCurrentStep(control.pixel_gate.frames[0].step, report.started_at, true, 1);
    assert.equal(
      (await reader.image(control.candidate)).rgba_sha256,
      raw.comparison.candidate_rgba_sha256,
    );
    assert.equal(group.snapshot_cleanup.empty_after_success_and_rejections, true);
    assert.deepEqual(await readdir(join(reader.root, group.snapshot_cleanup.directory)), []);
  } else {
    assert.deepEqual(group.batch.receipts, receipts);
    assert.equal(group.batch.reverse_exact, 12);
    assert.equal(group.batch.hold_pairs_exact, 4);
    for (let i = 0; i < 8; i += 2)
      assert.equal(receipts[i].rgba_sha256, receipts[i + 1].rgba_sha256);
    assert.equal(new Set(receipts.slice(8, 12).map((r) => r.rgba_sha256)).size, 4);
    assert.deepEqual(group.decode_cache, receipts.at(-1).media_decode_cache);
    assert.equal(group.decode_cache.decodes, 8);
    assert.equal(group.decode_cache.hits, 16);
  }
  return {
    frames: required.length,
    executions: receipts.length,
    checked_files: await inputs.verifyStable(),
  };
}
