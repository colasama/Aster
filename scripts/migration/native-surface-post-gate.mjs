import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { encodeRgbaPng } from "../parity/png.mjs";
import { M0Evidence } from "./m0-evidence.mjs";
import { runStep } from "./process.mjs";
import { writeAtomicJson } from "./report.mjs";

export async function runNativeSurfacePostGate(context, binary, execute = runStep) {
  const report = { status: "failed", required_count: 2, frames: [] };
  const reader = new M0Evidence(context.root);
  const local = (path) => relative(context.root, path).replaceAll("\\", "/");
  try {
    await mkdir(context.output, { recursive: true });
    const ledger = JSON.parse(
      await readFile(join(context.root, "docs/migration/rust-renderer-progress.json"), "utf8"),
    );
    const frozen = ledger.reference_baseline.native_surface_post;
    assert(frozen, "Native surface input manifest must be pinned");
    const manifest = await reader.json(frozen.path, frozen.sha256);
    const base = "tests/parity/native-surface-post";
    const reference = await reader.json(
      manifest.reference_manifest,
      manifest.reference_manifest_sha256,
    );
    assert.deepEqual(
      manifest.cases.map((c) => c.id),
      ["selectionIsolation", "vectorMotionBlur"],
    );
    assert.deepEqual(
      manifest.attachments.map((a) => a.role),
      ["scene", "objectId", "motionVector"],
    );
    for (const a of manifest.attachments) await reader.bytes(`${base}/${a.path}`, a.sha256);
    for (const c of manifest.cases) {
      const old = reference.cases.find((r) => r.id === c.id);
      assert.equal(old.input_sha256, c.captured_input_sha256);
      assert.equal(old.sha256, c.reference_sha256);
      assert.equal(old.path, c.reference);
      await reader.bytes(`${base}/${c.plan}`, c.plan_sha256);
      await reader.bytes(c.reference, c.reference_sha256);
    }
    report.gpu = await execute(
      {
        id: "native-surface-post-gpu",
        file: "cargo",
        args: [
          "test",
          "-p",
          "aster-renderer",
          "surface_post_supplied_gpu_outputs_and_controls",
          "--",
          "--ignored",
        ],
        env: { ASTER_SURFACE_POST_OUTPUT: context.output },
      },
      context,
    );
    assert.equal(report.gpu.status, "passed");
    for (const c of manifest.cases) {
      const caseId = `native-surface-${c.id}`;
      const referenceBytes = await reader.bytes(c.reference, c.reference_sha256);
      const actual = await reader.bytes(local(join(context.output, `${c.id}.rgba`)));
      assert.equal(actual.bytes.length, 64 * 48 * 4);
      const ref = join(context.output, `${c.id}.reference.png`),
        candidate = join(context.output, `${c.id}.png`);
      await writeFile(ref, encodeRgbaPng(64, 48, referenceBytes.bytes), { flag: "wx" });
      await writeFile(candidate, encodeRgbaPng(64, 48, actual.bytes), { flag: "wx" });
      const out = join(context.output, c.id);
      const ctx = join(context.output, `${c.id}.context.json`);
      await writeAtomicJson(ctx, { case_id: caseId, isolated: true, background: [0, 0, 0, 0] });
      const step = await execute(
        {
          id: `compare-${c.id}`,
          file: binary,
          args: [
            "compare",
            "--reference",
            ref,
            "--candidate",
            candidate,
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
      const evidencePath = local(join(out, "report.json"));
      const result = await reader.json(evidencePath);
      assert.equal(result.comparison.passed, true);
      assert.equal(result.comparison.reference_rgba_sha256, referenceBytes.sha256);
      assert.equal(result.comparison.candidate_rgba_sha256, actual.sha256);
      report.frames.push({
        case_id: caseId,
        frame: 0,
        comparison: result.comparison,
        evidence: evidencePath,
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
