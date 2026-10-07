import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { M0Evidence } from "./m0-evidence.mjs";
import { runStep } from "./process.mjs";
import { writeAtomicJson } from "./report.mjs";

export async function runNativeSurfaceFrameGate(
  context,
  { binary, compiler, validateReceipt },
  execute = runStep,
) {
  const report = { status: "failed", required_count: 16, frames: [] };
  const reader = new M0Evidence(context.root);
  const local = (path) => relative(context.root, path).replaceAll("\\", "/");
  try {
    await mkdir(context.output, { recursive: true });
    const ledger = await reader.json("docs/migration/rust-renderer-progress.json");
    const frozen = ledger.reference_baseline.native_surface_frame;
    assert(frozen, "Native surface frame inputs must be pinned");
    const manifest = await reader.json(frozen.path, frozen.sha256);
    const base = "tests/parity/native-surface-frame";
    assert.deepEqual(
      manifest.frames.map((f) => f.id),
      ["off", "fxaa", "ssaa2x", "ssaa4x"].flatMap((aa) =>
        ["selectionIsolation", "vectorMotionBlur"].flatMap((mode) =>
          ["ready", "skipped"].map((status) => `${mode}-${aa}-${status}`),
        ),
      ),
    );
    assert.equal(manifest.independent_ts_devices_exact, true);
    for (const file of manifest.files) await reader.bytes(`${base}/${file.path}`, file.sha256);
    const jobs = manifest.frames.map((f) => ({
      plan: join(context.root, base, f.plan),
      resources: join(context.root, base, "resources"),
      out: join(context.output, `${f.id}.png`),
    }));
    const batch = join(context.output, "jobs.json");
    await writeAtomicJson(batch, jobs);
    report.batch = await execute(
      {
        id: "native-surface-frame-batch",
        file: binary,
        args: ["render-plan", "--batch", batch, ...(compiler ? ["--dxcompiler", compiler] : [])],
      },
      context,
    );
    assert.equal(report.batch.status, "passed");
    const receipts = (await readFile(join(context.root, report.batch.log), "utf8"))
      .split(/\r?\n/)
      .filter((line) => line.startsWith('{"schema_version":'))
      .map((line) => JSON.parse(line));
    assert.equal(receipts.length, manifest.frames.length);
    for (const [index, f] of manifest.frames.entries()) {
      const candidate = await reader.image(local(jobs[index].out));
      const reference = await reader.image(`${base}/${f.reference}`);
      assert.equal(reference.rgba_sha256, f.reference_rgba_sha256);
      validateReceipt(receipts[index], {
        width: f.width,
        height: f.height,
        adapter: manifest.adapter,
        plan_sha256: f.plan_sha256,
        rgba_sha256: candidate.rgba_sha256,
      });
      assert.equal(receipts[index].frame_index, index);
      assert.equal(receipts[index].renderer_reused, index > 0);
      const caseId = `native-surface-frame-${f.id}`;
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
            join(context.root, base, f.reference),
            "--candidate",
            jobs[index].out,
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
      const evidence = local(join(out, "report.json"));
      const result = await reader.json(evidence);
      assert.equal(result.comparison.passed, true);
      assert.equal(result.comparison.reference_rgba_sha256, reference.rgba_sha256);
      assert.equal(result.comparison.candidate_rgba_sha256, candidate.rgba_sha256);
      report.frames.push({
        case_id: caseId,
        frame: 0,
        comparison: result.comparison,
        evidence,
        receipt: receipts[index],
      });
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
