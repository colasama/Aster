import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { encodeRgbaPng } from "../parity/png.mjs";
import { M0Evidence } from "./m0-evidence.mjs";
import { runStep } from "./process.mjs";
import { writeAtomicJson } from "./report.mjs";

/** Native accumulation consumes frozen samples, never the already-resolved reference output. */
export async function runNativeTemporalGate(context, binary, execute = runStep) {
  const report = { status: "failed", required_count: 4, frames: [] };
  const reader = new M0Evidence(context.root);
  const local = (path) => relative(context.root, path).replaceAll("\\", "/");
  try {
    await mkdir(context.output, { recursive: true });
    const ledger = await reader.json("docs/migration/rust-renderer-progress.json");
    const pinned = ledger.reference_baseline.native_temporal_text;
    assert(pinned, "Temporal sample input manifest must be pinned");
    const manifest = await reader.json(pinned.path, pinned.sha256);
    const base = "tests/parity/native-temporal-text";
    const donor = await reader.json(manifest.donor.path, manifest.donor.sha256);
    assert.equal(donor.milestone, "M2");
    assert.equal(donor.milestone_exit_satisfied, true);
    const temporal = donor.gates.find((g) => g.id === "G3").temporal_text;
    assert.equal(temporal.status, "passed");
    assert.equal(temporal.report, manifest.capture.path);
    const capture = await reader.json(manifest.capture.path, manifest.capture.sha256);
    assert.equal(capture.status, "passed");
    assert.deepEqual(manifest.reference_manifest, ledger.reference_baseline.temporal_text);
    const reference = await reader.json(
      manifest.reference_manifest.path,
      manifest.reference_manifest.sha256,
    );
    assert.deepEqual(
      manifest.cases.map((c) => c.id),
      ["full", "enters", "exits", "transparent"],
    );
    for (const item of manifest.cases) {
      const pass = temporal.pass_replays.find((p) => p.mode === item.id);
      const original = reference.cases.find((c) => c.mode === item.id);
      assert(pass && original);
      assert.equal(item.plan, `${item.id}.fpln`);
      assert.equal(item.reference, `tests/parity/temporal-text/reference/${original.path}`);
      assert.equal(item.plan_sha256, pass.plan_sha256);
      assert.equal(item.samples.length, pass.samples.length);
      assert.equal(item.reference_rgba_sha256, original.rgba_sha256);
      assert.equal(item.width, original.width);
      assert.equal(item.height, original.height);
      await reader.bytes(`${base}/${item.plan}`, item.plan_sha256);
      await reader.bytes(item.reference, original.png_sha256);
      for (const [index, sample] of item.samples.entries()) {
        assert.equal(sample.path, `${item.id}-${index}.rgba`);
        assert.equal(sample.frame, pass.samples[index].frame_hash);
        assert.equal(sample.pixel_hash, pass.samples[index].pixel_hash);
        assert.equal(sample.sha256, pass.samples[index].pixels_sha256);
        await reader.bytes(`${base}/${sample.path}`, sample.sha256);
      }
    }
    report.gpu = await execute(
      {
        id: "native-temporal-text-gpu",
        file: "cargo",
        args: [
          "test",
          "-p",
          "aster-renderer",
          "temporal_text_supplied_gpu_outputs_and_controls",
          "--",
          "--ignored",
        ],
        env: { ASTER_TEMPORAL_NATIVE_OUTPUT: context.output },
      },
      context,
    );
    assert.equal(report.gpu.status, "passed");
    for (const item of manifest.cases) {
      const caseId = `native-temporal-${item.id}`;
      const raw = await reader.bytes(local(join(context.output, `${item.id}.rgba`)));
      assert.equal(raw.bytes.length, item.width * item.height * 4);
      const candidate = join(context.output, `${item.id}.png`);
      await writeFile(candidate, encodeRgbaPng(item.width, item.height, raw.bytes), { flag: "wx" });
      const output = join(context.output, item.id);
      const ctx = join(context.output, `${item.id}.context.json`);
      await writeAtomicJson(ctx, { case_id: caseId, isolated: true, background: [0, 0, 0, 0] });
      const step = await execute(
        {
          id: `compare-temporal-${item.id}`,
          file: binary,
          args: [
            "compare",
            "--reference",
            join(context.root, item.reference),
            "--candidate",
            candidate,
            "--tolerance",
            "gpu",
            "--context",
            ctx,
            "--out",
            output,
          ],
        },
        context,
      );
      assert.equal(step.status, "passed");
      const path = local(join(output, "report.json"));
      const result = await reader.json(path);
      assert.equal(result.comparison.passed, true);
      assert.equal(result.comparison.reference_rgba_sha256, item.reference_rgba_sha256);
      assert.equal(result.comparison.candidate_rgba_sha256, raw.sha256);
      report.frames.push({
        case_id: caseId,
        frame: 0,
        comparison: result.comparison,
        evidence: path,
        step,
      });
    }
    for (const frame of report.frames) {
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
    }
    report.checked_files = await reader.stable();
    report.status = "passed";
  } catch (error) {
    report.error = error.stack ?? error.message;
  }
  await writeAtomicJson(join(context.output, "report.json"), report);
  return report;
}
