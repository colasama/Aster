import assert from "node:assert/strict";
import { posix } from "node:path";
import { M0Evidence, stableSource, validSha } from "./m0-evidence.mjs";
import { auditNativePixels, validateCurrentStep } from "./m3-pixels.mjs";
import { coreCases, coreCorpus, coreImageCases, coreSurfaceCases } from "./native-core-scope.mjs";
import { staticCommands } from "./static-checks.mjs";

export function validateM3Gates(report, corpus) {
  assert.equal(report.milestone, "M3");
  assert.equal(report.mode, "full");
  assert.deepEqual([...report.required_gates].sort(), ["G0", "G1", "G3"]);
  assert.deepEqual(report.gates.map((gate) => gate.id).sort(), ["G0", "G1", "G3"]);
  assert(report.gates.every((gate) => gate.status === "passed"));
  const [g0, ir, native] = ["G0", "G1", "G3"].map((id) => report.gates.find((g) => g.id === id));
  assert.deepEqual(
    g0.steps.map((step) => step.id).sort(),
    staticCommands()
      .map((step) => step.id)
      .sort(),
  );
  for (const step of g0.steps) validateCurrentStep(step, report.started_at);
  assert.equal(ir.source_unchanged, true);
  stableSource(ir.source, ir.source_after, "source_sha256");
  assert.equal(ir.source.source_sha256, validSha(report.source.source_sha256));
  assert(Date.parse(ir.started_at) >= Date.parse(report.started_at));
  assert.equal(ir.renderer_plan_complete, true);
  assert.equal(ir.binary.sha256, validSha(native.binary.sha256));
  assert.equal(native.scope, "native-core-v5");
  assert.equal(native.full_coverage, true);
  assert.equal(native.milestone_exit_eligible, true);
  assert.equal(native.native_gpu_execution, true);
  assert.deepEqual([...native.cases].sort(), [...coreCases].sort());
  const required = coreCorpus(corpus).cases.flatMap((item) =>
    item.frames.map((f) => `${item.id}:${f}`),
  );
  assert.equal(native.required_count, required.length);
  assert.deepEqual(native.frames.map((f) => `${f.case_id}:${f.frame}`).sort(), required.sort());
  for (const item of [native.build, native.image_cache])
    validateCurrentStep(item, report.started_at);
  for (const id of coreSurfaceCases) {
    for (const frame of native.frames.filter((f) => f.case_id === id)) {
      assert(frame.receipt.surface_cache.allocations > 0);
      assert(frame.receipt.surface_cache.resident_bytes > 0);
    }
  }
  assert.equal(native.native_stills.status, "passed");
  assert.equal(native.native_exr.status, "passed");
  assert.equal(native.native_exr.native_image_decode, true);
  assert.equal(native.native_exr.format, "rgba16float");
  assert.equal(native.native_exr.reference_boundary, "ts-exr-import");
  assert.equal(native.native_exr.ts_pixel_parity, false);
  return { ir, native };
}

/** M3 completion requires every core frame and native still/cache evidence from this full run. */
export async function auditM3Exit(root, report) {
  const reader = new M0Evidence(root);
  const ledger = await reader.json("docs/migration/rust-renderer-progress.json");
  for (const id of ["M0", "M1", "M2"])
    assert.equal(ledger.milestones.find((m) => m.id === id)?.status, "done");
  const milestone = ledger.milestones.find((m) => m.id === "M3");
  for (let i = 1; i <= 4; i++)
    assert.equal(milestone.tasks.find((t) => t.id === `M3-T${i}`)?.status, "done");
  assert(["in_progress", "done"].includes(milestone.tasks.find((t) => t.id === "M3-T5")?.status));
  const manifest = await reader.json(
    milestone.input_manifest.path,
    milestone.input_manifest.sha256,
  );
  const capture = await reader.json(milestone.input_capture.path, milestone.input_capture.sha256);
  assert.equal(capture.status, "passed");
  const corpus = await reader.json("tests/parity/corpus.json", manifest.corpus_sha256);
  const { ir, native } = validateM3Gates(report, corpus);
  assert.deepEqual(native.input_manifest, milestone.input_manifest);
  for (const file of [native.binary, native.dxcompiler, native.native_stills.ffmpeg].filter(
    Boolean,
  ))
    await reader.bytes(file.path, file.sha256);
  for (const path of [ir.schema.path, ir.schema.generated])
    await reader.bytes(path, ir.schema.sha256);
  const base = posix.dirname(milestone.input_manifest.path);
  const core = await auditNativePixels(reader, native, coreCorpus(corpus), report, base, false);
  const stills = await auditNativePixels(
    reader,
    native.native_stills,
    { cases: corpus.cases.filter((item) => coreImageCases.includes(item.id)) },
    report,
    base,
    true,
  );
  const cacheLog = (await reader.bytes(native.image_cache.log)).bytes.toString("utf8");
  for (const name of [
    "native_image_cache_reuses_generations_and_admits_atomically",
    "native_image_cache_preserves_exr_hdr_through_shared_shader",
    "native_surface_cache_admits_atomically_reuses_and_retires_targets",
  ])
    assert(cacheLog.includes(`${name} ... ok`), `Missing actual GPU check: ${name}`);
  for (const [records, ids] of [
    [
      native.rejections,
      [
        "existing-output",
        "resource-budget",
        "gpu-budget",
        "image-budget",
        "raster-budget",
        "generator-budget",
        "corrupt-resource",
        ...(report.runtime.platform === "win32" ? ["missing-compiler"] : []),
      ],
    ],
    [
      native.native_stills.rejections,
      ["missing-grant", "wrong-scope", "wrong-sha", "source-budget", "pixel-budget"],
    ],
  ]) {
    assert.deepEqual(records.map((r) => r.id).sort(), ids.sort());
    for (const item of records) {
      assert.equal(item.rejected, true);
      assert.equal(item.output_unchanged, true);
      validateCurrentStep(item.step, report.started_at, true);
      const log = (await reader.bytes(item.step.log)).bytes.toString("utf8");
      assert.equal(JSON.parse(log.trim().split(/\r?\n/).at(-1)).error, item.error);
    }
  }
  const exr = native.native_exr;
  validateCurrentStep(exr.step, report.started_at);
  const exrLog = (await reader.bytes(exr.step.log)).bytes.toString("utf8");
  assert.deepEqual(JSON.parse(exrLog.trim().split(/\r?\n/).at(-1)), exr.receipt);
  assert.equal(exr.receipt.native_gpu_execution, true);
  assert.equal(exr.receipt.native_image_decode, true);
  assert.equal(exr.receipt.native_images[0].backend, "rust-exr-snapshot");
  assert.equal(exr.receipt.native_images[0].format, "rgba16float");
  assert.equal(
    (await reader.image(exr.output.path, exr.output.sha256)).rgba_sha256,
    exr.receipt.rgba_sha256,
  );
  const boundaries = ["ts-exr-import", "ts-path-mask", "minimal-golden-occluded-animation"].map(
    (id) => {
      const boundary = ledger.known_boundaries.find((b) => b.id === id);
      assert(boundary);
      return boundary;
    },
  );
  return {
    status: "passed",
    scope: "M3 native core",
    native_gpu_execution: true,
    core,
    stills,
    exr: { native_numeric_and_gpu: true, ts_pixel_parity: false },
    boundaries,
    checked_files: await reader.stable(),
  };
}
