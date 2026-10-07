import assert from "node:assert/strict";
import { mkdir, readFile, stat } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { M0Evidence } from "./m0-evidence.mjs";
import { motionControlInputs } from "./native-motion-controls.mjs";
import { runStep } from "./process.mjs";
import { writeAtomicJson } from "./report.mjs";
import { hashFile } from "./source.mjs";

/** Validate complete temporal beauty output, reconstruction controls and retained target lifetimes. */
export async function runNativeMotionFrameGate(
  context,
  { binary, compiler, adapter, motionFrame, ordinaryFrame },
  execute = runStep,
) {
  const report = { status: "failed", frames: [], batches: [], controls: [] };
  const reader = new M0Evidence(context.root);
  const local = (p) => relative(context.root, p).replaceAll("\\", "/");
  try {
    await mkdir(context.output, { recursive: true });
    const ledger = await reader.json("docs/migration/rust-renderer-progress.json");
    const frozen = ledger.reference_baseline.native_motion_frame;
    assert(frozen);
    const manifest = await reader.json(frozen.path, frozen.sha256);
    const capture = await reader.json(manifest.capture.path, manifest.capture.sha256);
    const gpu = await reader.json(manifest.gpu_capture.path, manifest.gpu_capture.sha256);
    assert.equal(gpu.status, "passed");
    assert.equal(gpu.frame_capture.path, manifest.capture.path);
    assert.deepEqual(
      manifest.frames.map((f) => [f.mode, f.frame]),
      ["full", "enters", "exits"].flatMap((mode) => [
        [mode, 0],
        [mode, 1],
      ]),
    );
    for (const frame of manifest.frames) {
      const source = capture.frames.find((f) => f.mode === frame.mode && f.frame === frame.frame);
      assert(source);
      assert.deepEqual(frame.proof, source.proof);
      assert(
        frame.proof.exact &&
          frame.proof.independent_device &&
          frame.proof.warmed_cache &&
          frame.proof.changed_pixels > 16,
      );
      assert.equal(frame.plan.sha256, source.plan.sha256);
      assert.equal(frame.reference.sha256, source.reference.sha256);
      assert.equal(frame.reference.rgba_sha256, source.reference.rgba_sha256);
      assert.deepEqual(frame.resources, source.resources);
      await reader.bytes(frame.plan.path, frame.plan.sha256);
      await reader.bytes(frame.reference.path, frame.reference.sha256);
      assert.deepEqual(
        await reader.json(`${dirname(frame.plan.path)}/resources.json`),
        frame.resources.map((r) => r.message),
      );
      for (const r of frame.resources)
        await reader.bytes(
          `tests/parity/native-motion-frame/resources/${r.message.hash}.bin`,
          r.sha256,
        );
    }
    const controlInputs = await motionControlInputs(context, reader, motionFrame);
    const fromCorpus = async (f) => {
      await reader.bytes(f.input.path, f.input.sha256);
      return {
        plan: join(context.root, f.input.path),
        resources: join(context.root, dirname(dirname(f.input.path)), "frame-resources"),
      };
    };
    const frozenJobs = manifest.frames.map((f) => ({
      plan: join(context.root, f.plan.path),
      resources: join(context.root, "tests/parity/native-motion-frame/resources"),
    }));
    const ordinary = await fromCorpus(ordinaryFrame),
      original = await fromCorpus(motionFrame);
    const sequence = [
      ...frozenJobs,
      ordinary,
      frozenJobs[0],
      original,
      ...controlInputs.slice(0, 2).map(({ id: _, ...job }) => job),
      original,
    ];
    const pixels = [];
    for (const cached of [false, true]) {
      const label = cached ? "cached" : "uncached";
      const jobs = sequence.map((job, i) => ({
        ...job,
        out: join(context.output, label, `${i}.png`),
      }));
      const path = join(context.output, `${label}.json`);
      await writeAtomicJson(path, jobs);
      const step = await execute(
        {
          id: `motion-frames-${label}`,
          file: binary,
          args: [
            "render-plan",
            "--batch",
            path,
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
      assert.equal(receipts.length, sequence.length);
      for (const [i, r] of receipts.entries()) {
        const image = await reader.image(local(jobs[i].out));
        assert.equal(r.status, "passed");
        assert.equal(r.native_gpu_execution, true);
        assert.equal(r.native_image_decode, false);
        assert.equal(r.adapter.name, adapter);
        assert.equal(r.width, 320);
        assert.equal(r.height, 180);
        assert.equal(r.frame_index, i);
        assert.equal(r.renderer_reused, i > 0);
        assert.equal(r.output, jobs[i].out);
        assert.equal(r.plan_sha256, await hashFile(jobs[i].plan));
        assert.equal(r.rgba_sha256, image.rgba_sha256);
        const stats = r.motion_reconstruction;
        assert.equal(stats.passes, i === 6 ? 0 : 3);
        assert.equal(stats.allocations - stats.retirements, i === 6 ? 0 : 1);
        if (i === 6) {
          assert.equal(stats.resident_bytes, 0);
          assert.equal(r.rgba_sha256, ordinaryFrame.receipt.rgba_sha256);
        } else assert(stats.resident_bytes > 0);
        if (i < 6) {
          assert.equal(r.temporal_cache.passes, 1);
          assert.equal(r.temporal_cache.samples, i < 2 ? 8 : 4);
          assert.equal(r.rgba_sha256, manifest.frames[i].reference.rgba_sha256);
          if (i > 0) {
            assert.equal(stats.allocations, 1);
            assert.equal(stats.reuses, i);
          }
        }
        if (!cached) pixels.push(image);
        else assert.equal(image.rgba_sha256, pixels[i].rgba_sha256, "Cached motion output differs");
      }
      assert(
        receipts[7].motion_reconstruction.allocations >
          receipts[6].motion_reconstruction.allocations,
      );
      assert(receipts[11].motion_reconstruction.reuses > receipts[8].motion_reconstruction.reuses);
      report.batches.push({ label, step, receipts });
    }
    assert.equal(pixels[0].rgba_sha256, pixels[7].rgba_sha256);
    assert.equal(pixels[8].rgba_sha256, motionFrame.receipt.rgba_sha256);
    assert.equal(pixels[11].rgba_sha256, pixels[8].rgba_sha256);
    assert.equal(
      pixels[9].rgba_sha256,
      pixels[10].rgba_sha256,
      "Zero radius and zero vectors must agree",
    );
    for (const index of [9, 10]) {
      let changed = 0;
      for (let p = 0; p < pixels[8].pixels.length; p += 4)
        if (!pixels[8].pixels.subarray(p, p + 4).equals(pixels[index].pixels.subarray(p, p + 4)))
          changed++;
      assert(changed > 16, "Motion controls did not change actual scene pixels");
      report.controls.push({
        id: controlInputs[index - 9].id,
        changed_pixels: changed,
        cached_exact: true,
      });
    }
    for (const [index, frame] of manifest.frames.entries()) {
      const caseId = `native-motion-frame-${frame.mode}`,
        out = join(context.output, `compare-${index}`),
        ctx = join(context.output, `${index}.context.json`);
      await writeAtomicJson(ctx, { case_id: caseId, isolated: true, background: [0, 0, 0, 0] });
      const step = await execute(
        {
          id: `compare-motion-frame-${index}`,
          file: binary,
          args: [
            "compare",
            "--reference",
            join(context.root, frame.reference.path),
            "--candidate",
            join(context.output, "cached", `${index}.png`),
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
      assert(result.comparison.passed);
      assert.equal(result.comparison.reference_rgba_sha256, frame.reference.rgba_sha256);
      assert(
        ledger.self_reviews.some(
          (r) =>
            r.case_id === caseId &&
            r.frame === frame.frame &&
            r.profile === "gpu" &&
            r.verdict === "accepted" &&
            r.reference_rgba_sha256 === result.comparison.reference_rgba_sha256 &&
            r.candidate_rgba_sha256 === result.comparison.candidate_rgba_sha256,
        ),
        "Motion self-review missing",
      );
      report.frames.push({
        case_id: caseId,
        frame: frame.frame,
        comparison: result.comparison,
        evidence: local(join(out, "report.json")),
        step,
      });
    }
    for (const [id, job, args, pattern] of [
      ["budget", original, ["--gpu-budget-bytes", "2000000"], /GPU allocation budget/],
      ["missing-auxiliary", controlInputs[2], [], /auxiliary/],
      ["wrong-output", controlInputs[3], [], /auxiliary beauty stage|output route/],
    ]) {
      const out = join(context.output, `rejected-${id}.png`);
      const step = await execute(
        {
          id: `reject-motion-${id}`,
          file: binary,
          args: [
            "render-plan",
            "--plan",
            job.plan,
            "--resources",
            job.resources,
            "--out",
            out,
            ...args,
          ],
        },
        context,
      );
      assert.equal(step.exit_code, 2);
      assert.match(await readFile(join(context.root, step.log), "utf8"), pattern);
      await assert.rejects(stat(out), { code: "ENOENT" });
      report.controls.push({ id, rejected: true, output_absent: true, step });
    }
    report.checked_files = await reader.stable();
    report.status = "passed";
  } catch (error) {
    report.error = error.stack ?? error.message;
  }
  await writeAtomicJson(join(context.output, "report.json"), report);
  return report;
}
