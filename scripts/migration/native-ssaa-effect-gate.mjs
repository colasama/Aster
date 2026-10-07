import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { encodeRgbaPng } from "../parity/png.mjs";
import { M0Evidence } from "./m0-evidence.mjs";
import { runStep } from "./process.mjs";
import { writeAtomicJson } from "./report.mjs";

/** Negative control: reduced effect grids are rejected; production keeps full-resolution effects. */
export async function runNativeSsaaEffectGate(context, binary, execute = runStep) {
  const report = {
    status: "failed",
    strategy: "output-resolution-rgba16-effect-with-bilinear-reconstruction",
    strategy_enabled: false,
    decision: "rejected",
    required_count: 4,
    frames: [],
  };
  const reader = new M0Evidence(context.root);
  const local = (path) => relative(context.root, path).replaceAll("\\", "/");
  try {
    await mkdir(context.output, { recursive: true });
    report.gpu = await execute(
      {
        id: "ssaa-effect-resolution-gpu-evaluation",
        file: "cargo",
        args: [
          "test",
          "-p",
          "aster-renderer",
          "ssaa_effect_resolution_gpu_evaluation",
          "--",
          "--ignored",
        ],
        env: { ASTER_SSAA_EXPERIMENT_OUTPUT: context.output },
      },
      context,
    );
    assert.equal(
      report.gpu.status,
      "passed",
      "Full-resolution controls must equal the native renderer",
    );
    for (const id of ["blur-ssaa2x", "glow-ssaa2x", "blur-ssaa4x", "glow-ssaa4x"]) {
      const caseId = `ssaa-reduction-${id}`;
      const images = {};
      for (const kind of ["reference", "candidate"]) {
        const raw = await reader.bytes(local(join(context.output, `${id}.${kind}.rgba`)));
        const path = join(context.output, `${id}.${kind}.png`);
        await writeFile(path, encodeRgbaPng(320, 180, raw.bytes), { flag: "wx" });
        images[kind] = { path, sha256: raw.sha256 };
      }
      const ctx = join(context.output, `${id}.context.json`);
      await writeAtomicJson(ctx, { case_id: caseId, isolated: true, background: [0, 0, 0, 0] });
      const destination = join(context.output, id);
      const step = await execute(
        {
          id: `reject-ssaa-reduction-${id}`,
          file: binary,
          args: [
            "compare",
            "--reference",
            images.reference.path,
            "--candidate",
            images.candidate.path,
            "--context",
            ctx,
            "--tolerance",
            "gpu",
            "--out",
            destination,
          ],
        },
        context,
      );
      assert.equal(step.status, "failed", "An unsafe reduced grid must not pass the pixel gate");
      const evidence = local(join(destination, "report.json"));
      const result = await reader.json(evidence);
      assert.equal(result.comparison.passed, false);
      assert(
        result.comparison.metrics.max_abs_channel_error > 8,
        "Residual exceeds the hard floor",
      );
      assert.equal(result.comparison.reference_rgba_sha256, images.reference.sha256);
      assert.equal(result.comparison.candidate_rgba_sha256, images.candidate.sha256);
      report.frames.push({
        case_id: caseId,
        frame: 0,
        comparison: result.comparison,
        evidence,
        step,
      });
    }
    const ledger = JSON.parse(
      await readFile(join(context.root, "docs/migration/rust-renderer-progress.json"), "utf8"),
    );
    for (const frame of report.frames) {
      assert(
        ledger.self_reviews.some(
          (review) =>
            review.case_id === frame.case_id &&
            review.profile === "gpu" &&
            review.verdict === "rejected" &&
            review.reference_rgba_sha256 === frame.comparison.reference_rgba_sha256 &&
            review.candidate_rgba_sha256 === frame.comparison.candidate_rgba_sha256,
        ),
        `Rejected experiment self-review missing: ${frame.case_id}`,
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
