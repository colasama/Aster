import assert from "node:assert/strict";
import { join, relative } from "node:path";
import { validateReport } from "../parity/pixel-gate.mjs";
import { PixelInputs } from "../parity/pixel-inputs.mjs";
import { reviewStatus } from "../parity/pixel-review.mjs";
import { validateNativeReceipt } from "./native-core-gate.mjs";
import { suppliedFrameRecord } from "./supplied-frame-inputs.mjs";

export function validateCurrentStep(step, startedAt, rejected = false, rejectionExitCode = 2) {
  assert.equal(step.status, rejected ? "failed" : "passed");
  assert.equal(step.exit_code, rejected ? rejectionExitCode : 0);
  assert(!step.error && !step.signal, "Interrupted native evidence");
  assert(Date.parse(step.started_at) >= Date.parse(startedAt), "Stale native evidence");
  assert(Date.parse(step.finished_at) >= Date.parse(step.started_at));
}

/** Re-read actual pixels, CLI receipts, comparison reports and accepted reviews without rerendering. */
export async function auditNativePixels(reader, group, corpus, report, base, decoded) {
  const required = corpus.cases.flatMap((item) =>
    item.frames.map((frame) => `${item.id}:${frame}`),
  );
  const indexed = (records) => {
    assert.deepEqual(
      records.map((item) => `${item.case_id}:${item.frame}`).sort(),
      [...required].sort(),
    );
    return new Map(records.map((item) => [`${item.case_id}:${item.frame}`, item]));
  };
  const native = indexed(group.frames),
    frames = indexed(group.pixels.frames);
  const comparisons = indexed(group.pixels.comparisons);
  assert.equal(group.pixels.status, "passed");
  assert.equal(group.pixels.inputs_unchanged, true);
  assert.deepEqual(
    group.pixels.evidence,
    group.pixels.comparisons.map((item) => item.evidence),
  );
  await reader.bytes(group.candidate_manifest.path, group.candidate_manifest.sha256);
  const inputs = new PixelInputs({ root: reader.root, env: process.env });
  const entries = await inputs.load(
    join(reader.root, group.candidate_manifest.path),
    "diagnostic",
    "gpu",
  );
  indexed(entries);
  const receiptsByLog = new Map();
  for (const entry of entries) {
    const key = `${entry.case_id}:${entry.frame}`,
      execution = native.get(key);
    const checked = frames.get(key),
      comparison = comparisons.get(key);
    assert.equal(checked.status, "passed");
    assert.equal(checked.profile, "gpu");
    for (const step of [execution.step, checked.step]) validateCurrentStep(step, report.started_at);
    if (!receiptsByLog.has(execution.step.log)) {
      const log = (await reader.bytes(execution.step.log)).bytes.toString("utf8");
      receiptsByLog.set(
        execution.step.log,
        log
          .split(/\r?\n/)
          .filter((line) => line.startsWith('{"schema_version":'))
          .map((line) => JSON.parse(line)),
      );
    }
    const receipts = receiptsByLog.get(execution.step.log);
    assert.deepEqual(receipts[execution.receipt.frame_index], execution.receipt);
    const repair = inputs.ledger.reference_repairs?.find(
      (r) =>
        r.kind === "material-ready-first-frame-reference-repair-v1" &&
        r.case_id === entry.case_id &&
        r.frame === entry.frame,
    );
    let suppliedBase = base;
    if (repair) {
      const pin = inputs.ledger.milestones.find((m) => m.id === "M3").input_manifest;
      const manifest = await reader.json(pin.path, pin.sha256);
      suppliedBase = (await suppliedFrameRecord(reader, entry.item, entry.frame, base, manifest))
        .base;
    }
    assert.equal(
      execution.input.path,
      `${suppliedBase}/${entry.case_id}/${entry.frame}/${decoded ? "plan" : "replay"}.fpln`,
    );
    const plan = await reader.bytes(execution.input.path, execution.input.sha256);
    assert.equal(execution.output.path, relative(reader.root, entry.path).replaceAll("\\", "/"));
    const pixels = await reader.image(execution.output.path, execution.output.sha256);
    assert.equal(pixels.png_sha256, entry.png_sha256);
    const meta = await reader.json(`${suppliedBase}/${entry.case_id}/${entry.frame}/meta.json`);
    validateNativeReceipt(execution.receipt, {
      plan_sha256: plan.sha256,
      rgba_sha256: pixels.rgba_sha256,
      ...entry.item.size,
      adapter: meta.adapter.gpuMemory.device,
    });
    assert.equal(execution.receipt.native_image_decode, decoded);
    assert.equal(
      execution.step.command[0],
      join(reader.root, report.gates.find((g) => g.id === "G3").binary.path),
    );
    const evidence = comparison.evidence;
    assert.deepEqual(checked.evidence, evidence);
    const raw = await reader.json(evidence.report, evidence.report_sha256);
    assert.deepEqual(raw.comparison, comparison.comparison);
    assert.equal(raw.comparison.candidate_rgba_sha256, pixels.rgba_sha256);
    validateReport(raw, await inputs.prepare(entry), checked.step, inputs);
    assert.equal((await reviewStatus(inputs, entry, raw)).status, "passed");
    for (const name of ["heatmap", "contact_sheet"])
      await reader.bytes(evidence[name], evidence[`${name}_sha256`]);
    if (decoded) {
      assert.equal(execution.receipt.native_images.length, 1);
      assert.equal(
        execution.receipt.native_images[0].backend,
        process.platform === "win32" && entry.case_id === "media-png"
          ? "windows-wic-png-snapshot"
          : "ffmpeg-still-snapshot",
      );
      assert(execution.receipt.image_cache.uploads > 0);
    }
  }
  assert.deepEqual(inputs.referenceBinding(), group.pixels.reference_binding);
  return { frames: entries.length, checked_files: await inputs.verifyStable() };
}
