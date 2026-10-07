import assert from "node:assert/strict";
import { mkdir, readFile, stat } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { M0Evidence } from "./m0-evidence.mjs";
import { temporalControlInputs } from "./native-temporal-controls.mjs";
import { runStep } from "./process.mjs";
import { writeAtomicJson } from "./report.mjs";
import { hashFile } from "./source.mjs";

/** Derived rasters must affect nested effects without uploading captured resolved pixels. */
export async function runNativeTemporalFrameGate(
  context,
  { binary, compiler, adapter, nonTemporal },
  execute = runStep,
) {
  const report = { status: "failed", frames: [], batches: [], controls: [] };
  const reader = new M0Evidence(context.root);
  const local = (p) => relative(context.root, p).replaceAll("\\", "/");
  try {
    await mkdir(context.output, { recursive: true });
    const ledger = await reader.json("docs/migration/rust-renderer-progress.json");
    const frozen = ledger.reference_baseline.native_temporal_frame;
    assert(frozen);
    const manifest = await reader.json(frozen.path, frozen.sha256);
    const capture = await reader.json(manifest.capture.path, manifest.capture.sha256);
    const gpu = await reader.json(manifest.gpu_capture.path, manifest.gpu_capture.sha256);
    assert.equal(gpu.status, "passed");
    assert.equal(gpu.frame_capture.path, manifest.capture.path);
    assert.deepEqual(
      manifest.frames.map((f) => [f.mode, f.frame]),
      [
        ["recursive-effects", 0],
        ["recursive-effects", 1],
      ],
    );
    for (const frame of manifest.frames) {
      const original = capture.frames.find((f) => f.mode === frame.mode && f.frame === frame.frame);
      assert(original);
      assert.deepEqual(frame.proof, original.proof);
      assert(frame.proof.exact && frame.proof.independent_device && frame.proof.warmed_cache);
      assert(frame.proof.changed_pixels > 16 && frame.proof.surfaces >= 2);
      assert.equal(frame.plan.sha256, original.plan.sha256);
      assert.equal(frame.reference.sha256, original.reference.sha256);
      assert.equal(frame.reference.rgba_sha256, original.reference.rgba_sha256);
      await reader.bytes(frame.plan.path, frame.plan.sha256);
      await reader.bytes(frame.reference.path, frame.reference.sha256);
      assert.deepEqual(frame.resources, original.resources);
      const messages = await reader.json(
        `${dirname(frame.plan.path).replaceAll("\\", "/")}/resources.json`,
      );
      assert.deepEqual(
        messages,
        frame.resources.map((r) => r.message),
      );
      for (const r of frame.resources)
        await reader.bytes(
          `tests/parity/native-temporal-frame/resources/${r.message.hash}.bin`,
          r.sha256,
        );
    }
    const mutations = await temporalControlInputs(context, reader, manifest.frames[0]);
    const original = manifest.frames.map((frame) => ({
      id: `original-${frame.frame}`,
      plan: join(context.root, frame.plan.path),
      resources: join(context.root, "tests/parity/native-temporal-frame/resources"),
    }));
    await reader.bytes(nonTemporal.input.path, nonTemporal.input.sha256);
    const ordinary = {
      id: "ordinary-raster",
      plan: join(context.root, nonTemporal.input.path),
      resources: join(context.root, dirname(dirname(nonTemporal.input.path)), "frame-resources"),
    };
    const sequence = [
      original[0],
      original[0],
      ...mutations.filter((m) => m.id !== "surface-skip-route"),
      original[0],
      original[1],
      original[1],
      ordinary,
      original[0],
    ];
    const pixels = [];
    for (const cached of [false, true]) {
      const label = cached ? "cached" : "uncached";
      const jobs = sequence.map(({ id: _, ...job }, index) => ({
        ...job,
        out: join(context.output, label, `${index}.png`),
      }));
      const batch = join(context.output, `${label}.json`);
      await writeAtomicJson(batch, jobs);
      const step = await execute(
        {
          id: `temporal-frames-${label}`,
          file: binary,
          args: [
            "render-plan",
            "--batch",
            batch,
            "--dxcompiler",
            compiler,
            "--layer-cache-bytes",
            cached ? "67108864" : "0",
          ],
        },
        context,
      );
      assert.equal(step.status, "passed");
      const receipts = (await readFile(join(context.root, step.log), "utf8"))
        .split(/\r?\n/)
        .filter((l) => l.startsWith('{"schema_version":'))
        .map((l) => JSON.parse(l));
      assert.equal(receipts.length, jobs.length);
      for (const [index, receipt] of receipts.entries()) {
        const image = await reader.image(local(jobs[index].out));
        assert.equal(receipt.status, "passed");
        assert.equal(receipt.native_gpu_execution, true);
        assert.equal(receipt.native_image_decode, false);
        assert.equal(receipt.adapter.name, adapter);
        assert.equal(receipt.width, 320);
        assert.equal(receipt.height, 180);
        assert.equal(receipt.rgba_sha256, image.rgba_sha256);
        assert.equal(receipt.plan_sha256, await hashFile(jobs[index].plan));
        assert.equal(receipt.frame_index, index);
        assert.equal(receipt.renderer_reused, index > 0);
        assert.equal(receipt.output, jobs[index].out);
        if (sequence[index].id === "ordinary-raster") {
          assert.equal(receipt.temporal_cache.passes, 0);
          assert.equal(receipt.temporal_cache.samples, 0);
          assert.equal(receipt.temporal_cache.resident_bytes, 0);
          assert.equal(receipt.rgba_sha256, nonTemporal.receipt.rgba_sha256);
        } else {
          assert.equal(receipt.temporal_cache.passes, 1);
          assert.equal(receipt.temporal_cache.samples, 8);
          assert.equal(receipt.temporal_cache.allocations - receipt.temporal_cache.evictions, 1);
          assert.equal(
            receipt.temporal_cache.resident_bytes,
            receipts[0].temporal_cache.resident_bytes,
          );
        }
        if (!cached) pixels.push(image);
        else
          assert.equal(
            image.rgba_sha256,
            pixels[index].rgba_sha256,
            "Temporal effect cache changed pixels",
          );
      }
      assert.equal(
        receipts[0].image_cache.uploads,
        8,
        "Resolved reference output must not be uploaded",
      );
      assert.equal(receipts[2].image_cache.uploads, 8);
      assert.equal(
        receipts[2].temporal_cache.allocations,
        1,
        "Poisoned reference pixels cannot invalidate derived output",
      );
      assert(receipts[2].temporal_cache.reuses >= 2);
      assert(receipts[3].temporal_cache.allocations > receipts[2].temporal_cache.allocations);
      assert(receipts[4].temporal_cache.allocations > receipts[3].temporal_cache.allocations);
      if (cached) {
        assert(receipts[2].layer_cache.hits >= 4);
        assert(receipts[3].layer_cache.misses > receipts[2].layer_cache.misses);
        assert(receipts[4].layer_cache.misses > receipts[3].layer_cache.misses);
      }
      report.batches.push({ label, step, receipts });
    }
    for (const index of [1, 2, 5, 6, 7, 9])
      assert.equal(pixels[index].rgba_sha256, pixels[0].rgba_sha256);
    for (const index of [3, 4]) {
      let changed = 0;
      for (let i = 0; i < pixels[0].pixels.length; i += 4)
        if (!pixels[0].pixels.subarray(i, i + 4).equals(pixels[index].pixels.subarray(i, i + 4)))
          changed++;
      assert(changed > 16, "Changed temporal inputs did not affect nested scene output");
      report.controls.push({ id: sequence[index].id, changed_pixels: changed, cached_exact: true });
    }
    for (const frame of manifest.frames) {
      const caseId = "native-temporal-frame-recursive-effects";
      const ctx = join(context.output, `${frame.frame}.context.json`);
      await writeAtomicJson(ctx, { case_id: caseId, isolated: true, background: [0, 0, 0, 0] });
      const out = join(context.output, `compare-${frame.frame}`);
      const step = await execute(
        {
          id: `compare-temporal-frame-${frame.frame}`,
          file: binary,
          args: [
            "compare",
            "--reference",
            join(context.root, frame.reference.path),
            "--candidate",
            join(context.output, "cached", `${frame.frame ? 6 : 0}.png`),
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
      assert.equal(step.status, "passed");
      const result = await reader.json(local(join(out, "report.json")));
      assert.equal(result.comparison.reference_rgba_sha256, frame.reference.rgba_sha256);
      assert.equal(result.comparison.passed, true);
      report.frames.push({
        case_id: caseId,
        frame: frame.frame,
        comparison: result.comparison,
        evidence: local(join(out, "report.json")),
        step,
      });
    }
    for (const [id, job, extra, pattern] of [
      ["budget", original[0], ["--gpu-budget-bytes", "1000000"], /GPU allocation budget/],
      ["surface-skip-route", mutations.at(-1), [], /surface route disagrees/],
    ]) {
      const out = join(context.output, `rejected-${id}.png`);
      const step = await execute(
        {
          id: `reject-temporal-${id}`,
          file: binary,
          args: [
            "render-plan",
            "--plan",
            job.plan,
            "--resources",
            job.resources,
            "--out",
            out,
            ...extra,
          ],
        },
        context,
      );
      assert.equal(step.exit_code, 2);
      assert.match(await readFile(join(context.root, step.log), "utf8"), pattern);
      await assert.rejects(stat(out), { code: "ENOENT" });
      report.controls.push({ id, rejected: true, output_absent: true, step });
    }
    for (const frame of report.frames)
      assert(
        ledger.self_reviews.some(
          (r) =>
            r.case_id === frame.case_id &&
            r.frame === frame.frame &&
            r.profile === "gpu" &&
            r.verdict === "accepted" &&
            r.reference_rgba_sha256 === frame.comparison.reference_rgba_sha256 &&
            r.candidate_rgba_sha256 === frame.comparison.candidate_rgba_sha256,
        ),
        `Self-review missing: ${frame.frame}`,
      );
    report.checked_files = await reader.stable();
    report.status = "passed";
  } catch (error) {
    report.error = error.stack ?? error.message;
  }
  await writeAtomicJson(join(context.output, "report.json"), report);
  return report;
}
