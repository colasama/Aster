import assert from "node:assert/strict";
import { stat } from "node:fs/promises";
import { posix, relative, toNamespacedPath } from "node:path";
import { validSha } from "./m0-evidence.mjs";
import { validateCurrentStep } from "./m3-pixels.mjs";

const local = (reader, p) =>
  relative(toNamespacedPath(reader.root), toNamespacedPath(p)).replaceAll("\\", "/");

async function compare(reader, frame, report, ledger) {
  validateCurrentStep(frame.step, report.started_at);
  const raw = await reader.json(frame.evidence);
  assert.deepEqual(raw.comparison, frame.comparison);
  assert.equal(raw.context.case_id, frame.case_id);
  assert.equal(raw.comparison.profile.name, "gpu");
  assert(raw.comparison.passed && raw.comparison.checks.every((c) => c.passed));
  for (const side of ["reference", "candidate"]) {
    const pixels = await reader.image(local(reader, raw[side].path), raw[side].png_sha256);
    assert.equal(pixels.rgba_sha256, raw.comparison[`${side}_rgba_sha256`]);
  }
  const review = ledger.self_reviews.findLast(
    (r) =>
      r.case_id === frame.case_id &&
      r.frame === frame.frame &&
      r.profile === "gpu" &&
      r.reference_rgba_sha256 === raw.comparison.reference_rgba_sha256 &&
      r.candidate_rgba_sha256 === raw.comparison.candidate_rgba_sha256,
  );
  assert(review && review.verdict === "accepted");
  const evidence = await reader.json(review.evidence.report, review.evidence.report_sha256);
  for (const field of ["metrics", "ssim", "structural", "registration", "sequence"]) {
    assert.deepEqual(review[field], raw.comparison[field]);
    assert.deepEqual(evidence.comparison[field], raw.comparison[field]);
  }
  for (const name of ["contact_sheet", "heatmap"])
    await reader.bytes(review.evidence[name], validSha(review.evidence[`${name}_sha256`]));
  return raw;
}

async function frameGroup(reader, group, pin, report, ledger, motion) {
  const manifest = await reader.json(pin.path, pin.sha256);
  const capture = await reader.json(manifest.capture.path, manifest.capture.sha256);
  const gpu = await reader.json(manifest.gpu_capture.path, manifest.gpu_capture.sha256);
  assert.equal(gpu.status, "passed");
  assert.equal(gpu.frame_capture.path, manifest.capture.path);
  const expected = motion
    ? ["full", "enters", "exits"].flatMap((mode) => [
        [mode, 0],
        [mode, 1],
      ])
    : [
        ["recursive-effects", 0],
        ["recursive-effects", 1],
      ];
  assert.deepEqual(
    manifest.frames.map((f) => [f.mode, f.frame]),
    expected,
  );
  assert.equal(group.frames.length, expected.length);
  const base = posix.dirname(pin.path);
  for (const [i, frame] of manifest.frames.entries()) {
    const donor = capture.frames.find((f) => f.mode === frame.mode && f.frame === frame.frame);
    assert(donor);
    assert.deepEqual(frame.proof, donor.proof);
    assert(
      frame.proof.exact &&
        frame.proof.independent_device &&
        frame.proof.warmed_cache &&
        frame.proof.changed_pixels > 16,
    );
    assert.equal(frame.plan.sha256, donor.plan.sha256);
    assert.equal(frame.reference.sha256, donor.reference.sha256);
    assert.deepEqual(frame.resources, donor.resources);
    await reader.bytes(frame.plan.path, frame.plan.sha256);
    await reader.bytes(frame.reference.path, frame.reference.sha256);
    assert.deepEqual(
      await reader.json(`${posix.dirname(frame.plan.path)}/resources.json`),
      frame.resources.map((r) => r.message),
    );
    for (const r of frame.resources)
      await reader.bytes(`${base}/resources/${r.message.hash}.bin`, r.sha256);
    const actual = group.frames[i];
    assert.equal(
      actual.case_id,
      `${motion ? "native-motion-frame" : "native-temporal-frame"}-${frame.mode}`,
    );
    assert.equal(actual.frame, frame.frame);
    const raw = await compare(reader, actual, report, ledger);
    assert.equal(raw.comparison.reference_rgba_sha256, frame.reference.rgba_sha256);
  }
  assert.deepEqual(
    group.batches.map((b) => b.label),
    ["uncached", "cached"],
  );
  const images = [];
  for (const [batchIndex, batch] of group.batches.entries()) {
    validateCurrentStep(batch.step, report.started_at);
    const log = (await reader.bytes(batch.step.log)).bytes.toString("utf8");
    const receipts = log
      .split(/\r?\n/)
      .filter((l) => l.startsWith('{"schema_version":'))
      .map((l) => JSON.parse(l));
    assert.deepEqual(receipts, batch.receipts);
    assert.equal(receipts.length, motion ? 12 : 10);
    const jobs = await reader.json(
      local(reader, batch.step.command[batch.step.command.indexOf("--batch") + 1]),
    );
    assert.equal(jobs.length, receipts.length);
    for (const [i, r] of receipts.entries()) {
      assert.equal(r.status, "passed");
      assert.equal(r.native_gpu_execution, true);
      assert.equal(r.native_image_decode, false);
      assert.equal(r.frame_index, i);
      assert.equal(r.renderer_reused, i > 0);
      assert.equal(r.output, jobs[i].out);
      assert.equal((await reader.bytes(local(reader, jobs[i].plan))).sha256, r.plan_sha256);
      const image = await reader.image(local(reader, r.output));
      assert.equal(image.rgba_sha256, r.rgba_sha256);
      if (batchIndex === 0) images.push(image);
      else assert.equal(image.rgba_sha256, images[i].rgba_sha256);
      if (motion) {
        assert.equal(r.motion_reconstruction.passes, i === 6 ? 0 : 3);
        assert.equal(
          r.motion_reconstruction.allocations - r.motion_reconstruction.retirements,
          i === 6 ? 0 : 1,
        );
        if (i === 6) assert.equal(r.motion_reconstruction.resident_bytes, 0);
        if (i < 6) assert.equal(r.rgba_sha256, manifest.frames[i].reference.rgba_sha256);
      } else {
        assert.equal(r.temporal_cache.passes, i === 8 ? 0 : 1);
        assert.equal(r.temporal_cache.samples, i === 8 ? 0 : 8);
        if (i === 8) assert.equal(r.temporal_cache.resident_bytes, 0);
      }
    }
  }
  const controls = motion
    ? ["zero-radius", "zero-vectors", "budget", "missing-auxiliary", "wrong-output"]
    : ["zero-exposure", "changed-sample", "budget", "surface-skip-route"];
  assert.deepEqual(
    group.controls.map((c) => c.id),
    controls,
  );
  for (const [i, control] of group.controls.entries()) {
    if (i < 2) {
      const a = images[motion ? 8 : 0].pixels,
        b = images[(motion ? 9 : 3) + i].pixels;
      let changed = 0;
      for (let p = 0; p < a.length; p += 4)
        if (!a.subarray(p, p + 4).equals(b.subarray(p, p + 4))) changed++;
      assert(changed > 16);
      assert.equal(control.changed_pixels, changed);
      assert.equal(control.cached_exact, true);
    } else {
      assert(control.rejected && control.output_absent);
      validateCurrentStep(control.step, report.started_at, true);
      const log = (await reader.bytes(control.step.log)).bytes.toString("utf8");
      assert(JSON.parse(log.trim().split(/\r?\n/).at(-1)).error);
      const out = control.step.command[control.step.command.indexOf("--out") + 1];
      assert(local(reader, out).startsWith("artifacts/migration/"));
      await assert.rejects(stat(out), { code: "ENOENT" });
    }
  }
  if (motion) {
    assert.equal(images[0].rgba_sha256, images[7].rgba_sha256);
    assert.equal(images[8].rgba_sha256, images[11].rgba_sha256);
    assert.equal(images[9].rgba_sha256, images[10].rgba_sha256);
  } else
    for (const i of [1, 2, 5, 6, 7, 9]) assert.equal(images[i].rgba_sha256, images[0].rgba_sha256);
  return { frames: expected.length, executions: images.length * 2, controls: controls.length };
}

export async function auditM5Supplements(reader, native, report, ledger) {
  const temporal = native.native_temporal_text,
    pin = ledger.reference_baseline.native_temporal_text;
  const manifest = await reader.json(pin.path, pin.sha256);
  const donor = await reader.json(manifest.donor.path, manifest.donor.sha256);
  assert.equal(donor.milestone_exit_satisfied, true);
  assert.equal(donor.milestone, "M2");
  const capture = await reader.json(manifest.capture.path, manifest.capture.sha256);
  assert.equal(capture.status, "passed");
  validateCurrentStep(temporal.gpu, report.started_at);
  assert(
    (await reader.bytes(temporal.gpu.log)).bytes
      .toString("utf8")
      .includes("temporal_text_supplied_gpu_outputs_and_controls ... ok"),
  );
  assert.deepEqual(
    temporal.frames.map((f) => f.case_id),
    ["full", "enters", "exits", "transparent"].map((s) => `native-temporal-${s}`),
  );
  for (const [i, frame] of temporal.frames.entries()) {
    const item = manifest.cases[i];
    assert.equal(frame.case_id, `native-temporal-${item.id}`);
    await reader.bytes(`${posix.dirname(pin.path)}/${item.plan}`, item.plan_sha256);
    for (const sample of item.samples)
      await reader.bytes(`${posix.dirname(pin.path)}/${sample.path}`, sample.sha256);
    const raw = await compare(reader, frame, report, ledger);
    assert.equal(raw.comparison.reference_rgba_sha256, item.reference_rgba_sha256);
  }
  return {
    rasters: 4,
    recursive: await frameGroup(
      reader,
      native.native_temporal_frames,
      ledger.reference_baseline.native_temporal_frame,
      report,
      ledger,
      false,
    ),
    motion: await frameGroup(
      reader,
      native.native_motion_frames,
      ledger.reference_baseline.native_motion_frame,
      report,
      ledger,
      true,
    ),
  };
}
