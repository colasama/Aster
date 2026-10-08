import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { M0Evidence } from "./m0-evidence.mjs";
import { runStep } from "./process.mjs";
import { writeAtomicJson } from "./report.mjs";

export async function runNativeGeneratorSurfaceGate(
  context,
  { binary, compiler, validateReceipt },
  execute = runStep,
) {
  const report = {
    status: "failed",
    frames: [],
    batches: [],
    rejections: [],
    exact_cache_comparisons: 0,
    exact_restorations: 0,
  };
  const reader = new M0Evidence(context.root);
  const local = (p) => relative(context.root, p).replaceAll("\\", "/");
  try {
    await mkdir(context.output, { recursive: true });
    const ledger = await reader.json("docs/migration/rust-renderer-progress.json");
    const pin = ledger.reference_baseline.native_generator_surfaces;
    assert(pin, "Recursive generator references must be independently captured and pinned");
    const reference = await reader.json(pin.path, pin.sha256);
    assert.equal(reference.status, "passed");
    const expected = ["billboard", "mesh", "streak", "bars", "ring", "scope"].flatMap((kind) =>
      ["off", "fxaa", "ssaa2x", "ssaa4x"].flatMap((aa) =>
        [
          "child",
          "nested",
          "unavailable",
          ...(["bars", "ring", "scope"].includes(kind) ? ["shared", "inherited", "silent"] : []),
        ].map((mode) => `${kind}-${aa}-${mode}`),
      ),
    );
    assert.deepEqual(
      reference.frames.map((f) => f.id),
      expected,
    );
    assert.equal(reference.controls.length, 36);
    assert(reference.controls.every((c) => c.changed_bytes > 16));
    const gpu = reference.gpu_info.gpuDevice.find((g) => g.active);
    assert(gpu);
    const adapter = { name: gpu.deviceString, vendorId: gpu.vendorId, deviceId: gpu.deviceId };
    for (const f of reference.frames) {
      assert.equal(f.repeated_exact, true);
      for (const proof of [f.source, f.generator_source, f.plan, f.reference])
        await reader.bytes(proof.path, proof.sha256);
      for (const r of f.resources) await reader.bytes(r.path, r.sha256);
      assert.deepEqual(
        await reader.json(`${dirname(f.plan.path)}/resources.json`),
        f.resources.map((r) => r.message),
      );
    }
    report.reference = pin;
    report.controls = reference.controls;
    const restore = ["bars", "ring", "scope"].map((kind) =>
      reference.frames.find((f) => f.id === `${kind}-off-child`),
    );
    const receiptsByMode = [],
      pathsByMode = [];
    for (const cached of [false, true]) {
      const mode = cached ? "cached" : "uncached";
      const jobs = [...reference.frames, ...restore].map((f, i) => ({
        plan: join(context.root, f.plan.path),
        resources: join(context.root, dirname(f.resources[0].path)),
        out: join(context.output, mode, `${i}-${f.id}.png`),
      }));
      const path = join(context.output, `${mode}.json`);
      await writeAtomicJson(path, jobs);
      const step = await execute(
        {
          id: `native-generator-surface-${mode}`,
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
      report.batches.push(step);
      assert.equal(step.status, "passed", step.log);
      const receipts = (await readFile(join(context.root, step.log), "utf8"))
        .split(/\r?\n/)
        .filter((l) => l.startsWith('{"schema_version":'))
        .map((l) => JSON.parse(l));
      assert.equal(receipts.length, jobs.length);
      receiptsByMode.push(receipts);
      pathsByMode.push(jobs.map((j) => j.out));
      for (const [index, f] of [...reference.frames, ...restore].entries()) {
        const pixels = await reader.image(local(jobs[index].out));
        validateReceipt(receipts[index], {
          width: f.width,
          height: f.height,
          adapter,
          plan_sha256: f.plan.sha256,
          rgba_sha256: pixels.rgba_sha256,
        });
        assert.equal(receipts[index].frame_index, index);
        assert.equal(receipts[index].renderer_reused, index > 0);
        if (cached) {
          assert.equal(pixels.rgba_sha256, receiptsByMode[0][index].rgba_sha256);
          report.exact_cache_comparisons++;
        }
        if (index >= reference.frames.length) {
          assert.equal(
            pixels.rgba_sha256,
            receipts[reference.frames.findIndex((v) => v.id === f.id)].rgba_sha256,
          );
          report.exact_restorations++;
        }
      }
      for (const f of reference.frames.filter((f) => f.mode === "shared")) {
        const left = reference.frames.findIndex((v) => v.id === f.id),
          right = reference.frames.findIndex((v) => v.id === f.id.replace(/shared$/, "inherited"));
        assert.equal(
          receipts[left].rgba_sha256,
          receipts[right].rgba_sha256,
          "Root generators must inherit the child-provided frame audio",
        );
      }
    }
    for (const [index, f] of reference.frames.entries()) {
      const caseId = `native-generator-surface-${f.id}`,
        out = join(context.output, f.id),
        ctx = `${out}.context.json`;
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
      const evidence = local(join(out, "report.json")),
        result = await reader.json(evidence);
      report.frames.push({
        case_id: caseId,
        frame: 0,
        comparison: result.comparison,
        evidence,
        step,
        receipts: receiptsByMode.map((r) => r[index]),
      });
      assert.equal(step.status, "passed", `Recursive generator pixels failed: ${f.id}`);
      assert.equal(result.comparison.reference_rgba_sha256, f.reference.rgba_sha256);
      assert.equal(result.comparison.candidate_rgba_sha256, receiptsByMode[0][index].rgba_sha256);
    }
    const negative = await reader.json(pin.negative_inputs.path, pin.negative_inputs.sha256);
    assert.deepEqual(
      negative.map((f) => f.id),
      ["bars", "ring", "scope"].flatMap((k) =>
        ["off", "fxaa", "ssaa2x", "ssaa4x"].map((a) => `${k}-${a}-conflict`),
      ),
    );
    for (const f of negative) {
      const output = join(context.output, "rejections", f.id),
        resources = join(output, "resources");
      await mkdir(resources, { recursive: true });
      const plan = join(output, "plan.fpln"),
        pixels = join(output, "unexpected.png");
      await writeFile(plan, Buffer.from(f.plan));
      await writeAtomicJson(
        join(output, "resources.json"),
        f.resources.map((r) => r.message),
      );
      for (const r of f.resources)
        await writeFile(join(resources, `${r.message.hash}.bin`), Buffer.from(r.bytes));
      const step = await execute(
        {
          id: `reject-${f.id}`,
          file: binary,
          args: [
            "render-plan",
            "--plan",
            plan,
            "--resources",
            resources,
            "--out",
            pixels,
            ...(compiler ? ["--dxcompiler", compiler] : []),
          ],
        },
        context,
      );
      report.rejections.push(step);
      assert.equal(step.status, "failed");
      assert.equal(step.exit_code, 2);
      assert.match(
        await readFile(join(context.root, step.log), "utf8"),
        /generator audio differs within root frame/,
      );
      assert.equal(
        await readFile(pixels).then(
          () => true,
          () => false,
        ),
        false,
        "Rejected input published pixels",
      );
    }
    for (const f of report.frames)
      assert(
        ledger.self_reviews.some(
          (r) =>
            r.case_id === f.case_id &&
            r.frame === 0 &&
            r.profile === "gpu" &&
            r.verdict === "accepted" &&
            r.reference_rgba_sha256 === f.comparison.reference_rgba_sha256 &&
            r.candidate_rgba_sha256 === f.comparison.candidate_rgba_sha256,
        ),
        `Self-review missing: ${f.case_id}`,
      );
    report.checked_files = await reader.stable();
    report.status = "passed";
  } catch (error) {
    report.error = error.stack ?? error.message;
  }
  await writeAtomicJson(join(context.output, "report.json"), report);
  return report;
}
