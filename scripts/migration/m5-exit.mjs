import assert from "node:assert/strict";
import { posix } from "node:path";
import { M0Evidence } from "./m0-evidence.mjs";
import { auditNativePixels, validateCurrentStep } from "./m3-pixels.mjs";
import { auditM4Supplements } from "./m4-supplements.mjs";
import { validateM5Gates } from "./m5-gates.mjs";
import { auditM5Supplements } from "./m5-supplements.mjs";
import { nativeRasterCases } from "./native-raster-batch.mjs";

/** Completion requires current execution receipts and independently frozen raster provenance. */
export async function auditM5Exit(root, report) {
  const reader = new M0Evidence(root);
  const ledger = await reader.json("docs/migration/rust-renderer-progress.json");
  for (const id of ["M0", "M1", "M2", "M3", "M4"])
    assert.equal(ledger.milestones.find((m) => m.id === id)?.status, "done");
  const milestone = ledger.milestones.find((m) => m.id === "M5");
  for (const id of ["M5-T1", "M5-T2", "M5-T3"])
    assert.equal(milestone.tasks.find((t) => t.id === id)?.status, "done");
  assert(["in_progress", "done"].includes(milestone.tasks.find((t) => t.id === "M5-T4")?.status));
  const inputs = ledger.milestones.find((m) => m.id === "M3");
  const manifest = await reader.json(inputs.input_manifest.path, inputs.input_manifest.sha256);
  assert.equal(
    (await reader.json(inputs.input_capture.path, inputs.input_capture.sha256)).status,
    "passed",
  );
  const corpus = await reader.json("tests/parity/corpus.json", manifest.corpus_sha256);
  const { ir, native, selected } = validateM5Gates(report, corpus);
  assert.deepEqual(native.input_manifest, inputs.input_manifest);
  assert.deepEqual(await reader.json(ir.report_path), ir);
  for (const step of ir.steps) {
    validateCurrentStep(step, report.started_at, step.status === "failed");
    await reader.bytes(step.log);
  }
  for (const file of [native.binary, native.dxcompiler].filter(Boolean))
    await reader.bytes(file.path, file.sha256);
  for (const path of [ir.schema.path, ir.schema.generated])
    await reader.bytes(path, ir.schema.sha256);
  const base = posix.dirname(inputs.input_manifest.path);
  const pixels = await auditNativePixels(reader, native, selected, report, base, false);
  const batch = await reader.json(
    native.raster_batch.request.path,
    native.raster_batch.request.sha256,
  );
  const frames = native.frames.filter((f) => nativeRasterCases.includes(f.case_id));
  assert.equal(batch.length, frames.length);
  for (const [i, frame] of frames.entries()) {
    assert.equal(frame.receipt.frame_index, i);
    assert.equal(frame.receipt.renderer_reused, i > 0);
    assert.equal(batch[i].plan, frame.input.path);
    assert.equal(batch[i].out, frame.receipt.output);
    assert.equal(batch[i].resources, `${base}/${frame.case_id}/frame-resources`);
    assert(frame.receipt.image_cache.uploads > 0 && frame.receipt.image_cache.resident_bytes > 0);
    if (frame.case_id === "scene-motion-blur")
      assert.equal(frame.receipt.motion_reconstruction.passes, 3);
  }
  const gpuLog = (await reader.bytes(native.image_cache.log)).bytes.toString("utf8");
  assert(gpuLog.includes("native_image_cache_reuses_generations_and_admits_atomically ... ok"));
  const supplements = await auditM5Supplements(reader, native, report, ledger);
  const regressions = await auditM4Supplements(reader, native, report, ledger);
  return {
    status: "passed",
    scope: "M5 supplied text, SVG, PSD, temporal rasters and complete root motion output",
    native_gpu_execution: true,
    raster_frames: frames.length,
    pixels,
    supplements,
    regressions,
    boundaries: [
      "Text/SVG/PSD rasterization remains in the Phase A producer",
      "Native video and image sequences remain M6",
      "Depth effects, 3D shadows and generators remain M7",
      "Production preview/export remain TS until their integration milestones",
    ],
    checked_files: await reader.stable(),
  };
}
