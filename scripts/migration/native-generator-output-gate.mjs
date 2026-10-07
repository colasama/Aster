import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { M0Evidence } from "./m0-evidence.mjs";
import { runStep } from "./process.mjs";
import { writeAtomicJson } from "./report.mjs";
import { hashFile } from "./source.mjs";

export async function runNativeGeneratorOutputGate(
  context,
  { binary, compiler, validateReceipt },
  execute = runStep,
) {
  const report = { status: "failed", frames: [], batches: [], exact_cache_comparisons: 0 };
  const reader = new M0Evidence(context.root);
  const local = (p) => relative(context.root, p).replaceAll("\\", "/");
  try {
    await mkdir(context.output, { recursive: true });
    const ledger = await reader.json("docs/migration/rust-renderer-progress.json");
    const pin = ledger.reference_baseline.native_generator_output;
    assert(pin, "Generator output references must be captured independently and pinned");
    const manifest = await reader.json(pin.path, pin.sha256);
    assert.equal(manifest.status, "passed");
    const modes = [
      "normal",
      "objectId",
      "materialId",
      "worldPosition",
      "motionVector",
      "beauty",
      "beauty-motion",
      "depthOfField",
      "empty",
    ];
    const expected = ["billboard", "mesh", "streak", "bars", "ring", "scope"].flatMap((kind) =>
      ["off", "fxaa", "ssaa2x", "ssaa4x"].flatMap((aa) =>
        modes.map((mode) => ({ kind, aa, mode })),
      ),
    );
    assert.equal(manifest.frames.length, expected.length);
    assert.equal(manifest.controls.length, 24);
    assert(manifest.controls.every((c) => c.changed_bytes > 16));
    const gpu = manifest.gpu_info.gpuDevice.find((g) => g.active);
    assert(gpu, "Captured TS adapter absent");
    const adapter = { name: gpu.deviceString, vendorId: gpu.vendorId, deviceId: gpu.deviceId };
    for (const [index, f] of manifest.frames.entries()) {
      assert.deepEqual({ kind: f.kind, aa: f.aa, mode: f.mode }, expected[index]);
      assert.equal(f.id, `${f.kind}-${f.aa}-${f.mode}`);
      assert.equal(f.repeated_exact, true);
      await reader.bytes(f.source.path, f.source.sha256);
      await reader.bytes(f.plan.path, f.plan.sha256);
      await reader.bytes(f.reference.path, f.reference.sha256);
      assert.deepEqual(
        await reader.json(`${dirname(f.plan.path)}/resources.json`),
        f.resources.map((r) => r.message),
      );
      for (const r of f.resources) await reader.bytes(r.path, r.sha256);
    }
    report.reference = pin;
    report.controls = manifest.controls;
    const receiptsByMode = [],
      pathsByMode = [];
    for (const cached of [false, true]) {
      const mode = cached ? "cached" : "uncached";
      const jobs = manifest.frames.map((f) => ({
        plan: join(context.root, f.plan.path),
        resources: join(context.root, dirname(f.resources[0].path)),
        out: join(context.output, mode, `${f.id}.png`),
      }));
      const path = join(context.output, `${mode}.json`);
      await writeAtomicJson(path, jobs);
      const step = await execute(
        {
          id: `native-generator-output-${mode}`,
          file: binary,
          args: [
            "render-plan",
            "--batch",
            path,
            "--layer-cache-bytes",
            cached ? "67108864" : "0",
            ...(compiler ? ["--dxcompiler", compiler] : []),
          ],
          timeout_ms: 180000,
        },
        context,
      );
      report.batches.push({ step, request: { path: local(path), sha256: await hashFile(path) } });
      assert.equal(step.status, "passed", step.log);
      const receipts = (await readFile(join(context.root, step.log), "utf8"))
        .split(/\r?\n/)
        .filter((line) => line.startsWith('{"schema_version":'))
        .map((line) => JSON.parse(line));
      assert.equal(receipts.length, jobs.length);
      receiptsByMode.push(receipts);
      pathsByMode.push(jobs.map((j) => j.out));
      for (const [index, f] of manifest.frames.entries()) {
        const receipt = receipts[index],
          pixels = await reader.image(local(jobs[index].out));
        validateReceipt(receipt, {
          width: f.width,
          height: f.height,
          adapter,
          plan_sha256: f.plan.sha256,
          rgba_sha256: pixels.rgba_sha256,
        });
        assert.equal(receipt.frame_index, index);
        assert.equal(receipt.renderer_reused, index > 0);
        assert.equal(receipt.motion_reconstruction.passes, f.motion ? 3 : 0);
        assert.equal(receipt.depth_effects.passes, f.mode === "depthOfField" ? 5 : 0);
        if (!f.motion) assert.equal(receipt.motion_reconstruction.resident_bytes, 0);
        if (f.mode !== "depthOfField") assert.equal(receipt.depth_effects.resident_bytes, 0);
        if (cached) {
          assert.equal(pixels.rgba_sha256, receiptsByMode[0][index].rgba_sha256);
          report.exact_cache_comparisons++;
        }
      }
      for (const kind of ["bars", "ring", "scope"])
        for (const aa of ["off", "fxaa", "ssaa2x", "ssaa4x"]) {
          const normal = manifest.frames.findIndex((f) => f.id === `${kind}-${aa}-normal`);
          const empty = manifest.frames.findIndex((f) => f.id === `${kind}-${aa}-empty`);
          assert.equal(
            receipts[normal].rgba_sha256,
            receipts[empty].rgba_sha256,
            "A beauty-only plugin must not acquire invented auxiliary geometry",
          );
        }
    }
    for (const [index, f] of manifest.frames.entries()) {
      const caseId = `native-generator-output-${f.id}`;
      const ctx = join(context.output, `${f.id}.context.json`),
        out = join(context.output, f.id);
      await writeAtomicJson(ctx, { case_id: caseId, isolated: true, background: [0, 0, 0, 0] });
      const step = await execute(
        {
          id: `compare-${f.id}`,
          file: binary,
          args: [
            "compare",
            "--reference",
            join(context.root, f.reference.path),
            "--candidate",
            pathsByMode[0][index],
            "--tolerance",
            "gpu",
            "--context",
            ctx,
            "--out",
            out,
          ],
        },
        context,
      );
      assert.equal(step.status, "passed", `Generator output pixels failed: ${f.id}`);
      const evidence = local(join(out, "report.json")),
        result = await reader.json(evidence);
      assert.equal(result.comparison.passed, true);
      if (result.comparison.profile.case_override) {
        const applied = result.comparison.profile.case_override;
        const catalog = await reader.json(
          "tests/parity/tolerance-overrides.json",
          applied.catalog_sha256,
        );
        assert.equal(applied.case_id, caseId);
        assert.equal(
          catalog.cases[caseId].max_abs_channel_error,
          result.comparison.profile.limits.max_abs_channel_error,
        );
        assert(
          ledger.tolerance_overrides.some(
            (r) =>
              r.case_id === caseId &&
              r.profile === "gpu" &&
              r.catalog_sha256 === applied.catalog_sha256 &&
              r.status === "accepted" &&
              r.max_abs_channel_error === result.comparison.profile.limits.max_abs_channel_error,
          ),
          `Reviewed case tolerance missing: ${caseId}`,
        );
      }
      assert.equal(result.comparison.reference_rgba_sha256, f.reference.rgba_sha256);
      assert.equal(result.comparison.candidate_rgba_sha256, receiptsByMode[0][index].rgba_sha256);
      report.frames.push({
        case_id: caseId,
        frame: 0,
        comparison: result.comparison,
        evidence,
        step,
        receipts: receiptsByMode.map((r) => r[index]),
      });
    }
    for (const frame of report.frames)
      assert(
        ledger.self_reviews.some(
          (r) =>
            r.case_id === frame.case_id &&
            r.frame === 0 &&
            r.profile === "gpu" &&
            r.verdict === "accepted" &&
            r.reference_rgba_sha256 === frame.comparison.reference_rgba_sha256 &&
            r.candidate_rgba_sha256 === frame.comparison.candidate_rgba_sha256,
        ),
        `Self-review missing: ${frame.case_id}`,
      );
    report.checked_files = await reader.stable();
    report.status = "passed";
  } catch (error) {
    report.error = error.stack ?? error.message;
  }
  await writeAtomicJson(join(context.output, "report.json"), report);
  return report;
}
