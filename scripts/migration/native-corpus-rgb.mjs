import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { dirname, join, relative, resolve, toNamespacedPath } from "node:path";
import { runPixelGate, validateReport } from "../parity/pixel-gate.mjs";
import { PixelInputs } from "../parity/pixel-inputs.mjs";
import { reviewStatus } from "../parity/pixel-review.mjs";
import { checkpointSource } from "./checkpoint-source.mjs";
import { M0Evidence } from "./m0-evidence.mjs";
import { validateCurrentStep } from "./m3-pixels.mjs";
import { writeAtomicJson } from "./report.mjs";
import { hashFile } from "./source.mjs";

/** Conversion coverage cannot substitute for a comparison with the frozen RGB oracle. */
export function missingNativeRgbFrames(corpus, covered) {
  const required = corpus.cases.flatMap((item) =>
    item.frames.map((frame) => ({ case_id: item.id, frame })),
  );
  const identities = new Set(required.map((f) => `${f.case_id}/${f.frame}`));
  assert.equal(identities.size, required.length, "Duplicate corpus RGB frame");
  const seen = new Set();
  for (const frame of covered) {
    const id = `${frame.case_id}/${frame.frame}`;
    assert(identities.has(id) && !seen.has(id), "Unknown or duplicate native RGB frame");
    seen.add(id);
  }
  return required.filter((f) => !seen.has(`${f.case_id}/${f.frame}`));
}

/** Reuse authenticated pre-conversion PNGs; no extra GPU rendering or new reference capture. */
export async function readNativeRgbSupplement(reader, conversion, required) {
  assert.equal(conversion.full_coverage, true);
  assert.equal(conversion.source_unchanged, true);
  const sources = await checkpointSource(
    { root: reader.root, source: conversion.source },
    conversion,
  );
  const frames = [];
  for (const id of new Set(required.map((f) => f.case_id))) {
    const entry = conversion.cases.find((item) => item.id === id);
    assert(entry?.authenticated && entry.checkpoint, `Missing RGB capture for ${id}`);
    const checkpoint = await reader.json(entry.checkpoint.path, entry.checkpoint.sha256);
    sources.assert(checkpoint.execution_sha256);
    const raw = await reader.json(checkpoint.report.path, checkpoint.report.sha256);
    assert.deepEqual(raw.binary, conversion.binary);
    assert.deepEqual(raw.assignment, checkpoint.assignment);
    assert.equal(raw.assignment.case.id, id);
    const logs = new Map();
    for (const wanted of required.filter((f) => f.case_id === id)) {
      const captured = raw.frames.filter((f) => f.frame === wanted.frame);
      assert.equal(captured.length, 1, "Missing or duplicate supplied RGB capture");
      const frame = captured[0];
      const input = raw.assignment.inputs.find((f) => f.frame === wanted.frame);
      assert(input);
      if (!logs.has(frame.render_log.path)) {
        const log = await reader.bytes(frame.render_log.path, frame.render_log.sha256);
        logs.set(
          frame.render_log.path,
          log.bytes
            .toString("utf8")
            .split(/\r?\n/)
            .filter((line) => line.startsWith('{"schema_version":'))
            .map(JSON.parse),
        );
      }
      assert.deepEqual(logs.get(frame.render_log.path)[frame.batch_index], frame.receipt);
      const receipt = frame.receipt;
      assert.equal(receipt.status, "passed");
      assert.equal(receipt.native_gpu_execution, true);
      assert.equal(receipt.plan_sha256, input.plan.sha256);
      await reader.bytes(input.plan.path, input.plan.sha256);
      const image = await reader.image(frame.png.path, frame.png.sha256);
      assert.equal(image.rgba_sha256, receipt.rgba_sha256);
      assert.equal(
        toNamespacedPath(receipt.output),
        toNamespacedPath(resolve(reader.root, frame.png.path)),
      );
      assert.equal(receipt.width, raw.assignment.case.size.width);
      assert.equal(receipt.height, raw.assignment.case.size.height);
      frames.push({ ...wanted, output: frame.png, rgba_sha256: image.rgba_sha256 });
    }
  }
  assert.deepEqual(
    frames.map((f) => [f.case_id, f.frame]),
    required.map((f) => [f.case_id, f.frame]),
  );
  return frames;
}

export async function runNativeRgbSupplement(context, corpus, covered, conversion, execute) {
  const reader = new M0Evidence(context.root);
  const required = missingNativeRgbFrames(corpus, covered);
  const report = { status: "failed", required, frames: [], native_export_acceptance: false };
  try {
    assert(required.length > 0);
    report.frames = await readNativeRgbSupplement(reader, conversion, required);
    // A resumed conversion may live in another migration run; keep all paths contained here.
    const path = join(context.root, "artifacts/migration", `native-rgb-${randomUUID()}.json`);
    await writeAtomicJson(path, {
      schema_version: 1,
      frames: report.frames.map((frame) => ({
        case_id: frame.case_id,
        frame: frame.frame,
        path: relative(dirname(path), join(context.root, frame.output.path)).replaceAll("\\", "/"),
        png_sha256: frame.output.sha256,
      })),
    });
    report.candidate_manifest = {
      path: relative(context.root, path).replaceAll("\\", "/"),
      sha256: await hashFile(path),
    };
    report.pixels = await runPixelGate(
      { ...context, output: join(context.output, "native-rgb-supplement") },
      { manifestPath: path, scope: "diagnostic" },
      execute,
    );
    assert.equal(missingNativeRgbFrames(corpus, [...covered, ...report.frames]).length, 0);
    report.checked_files = await reader.stable();
    report.status = report.pixels.status;
  } catch (error) {
    report.error = error.stack ?? String(error);
  }
  await writeAtomicJson(join(context.output, "native-rgb-supplement-report.json"), report);
  return report;
}

/** Exit acceptance reopens pixels, frozen references, structural results and exact review identities. */
export async function auditNativeRgbSupplement(reader, native, corpus, report) {
  const group = native.native_rgb_supplement;
  assert.equal(group?.status, "passed", "Missing full-corpus native RGB supplement");
  const required = missingNativeRgbFrames(corpus, native.frames);
  assert.deepEqual(group.required, required);
  const frames = await readNativeRgbSupplement(reader, native.native_nv12, required);
  assert.deepEqual(group.frames, frames);
  assert.equal(missingNativeRgbFrames(corpus, [...native.frames, ...frames]).length, 0);
  assert.equal(group.pixels.status, "passed");
  assert.equal(group.pixels.inputs_unchanged, true);
  await reader.bytes(group.candidate_manifest.path, group.candidate_manifest.sha256);
  const inputs = new PixelInputs({ root: reader.root, env: process.env });
  const entries = await inputs.load(
    join(reader.root, group.candidate_manifest.path),
    "diagnostic",
    null,
  );
  for (const records of [entries, group.pixels.frames, group.pixels.comparisons])
    assert.deepEqual(
      records.map((f) => [f.case_id, f.frame]),
      required.map((f) => [f.case_id, f.frame]),
    );
  for (const [index, entry] of entries.entries()) {
    const checked = group.pixels.frames[index];
    const comparison = group.pixels.comparisons[index];
    const frame = frames[index];
    assert.equal(checked.status, "passed");
    assert.equal(entry.path, resolve(reader.root, frame.output.path));
    assert.equal(entry.png_sha256, frame.output.sha256);
    validateCurrentStep(checked.step, report.started_at);
    assert.deepEqual(checked.evidence, comparison.evidence);
    const evidence = comparison.evidence;
    const raw = await reader.json(evidence.report, evidence.report_sha256);
    assert.deepEqual(raw.comparison, comparison.comparison);
    assert.equal(raw.comparison.candidate_rgba_sha256, frame.rgba_sha256);
    validateReport(raw, await inputs.prepare(entry), checked.step, inputs);
    assert.equal((await reviewStatus(inputs, entry, raw)).status, "passed");
    for (const name of ["heatmap", "contact_sheet"])
      await reader.bytes(evidence[name], evidence[`${name}_sha256`]);
  }
  assert.deepEqual(inputs.referenceBinding(), group.pixels.reference_binding);
  return { frames: frames.length, checked_files: await inputs.verifyStable() };
}
