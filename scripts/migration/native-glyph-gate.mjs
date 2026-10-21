import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { encodeRgbaPng } from "../parity/png.mjs";
import { M0Evidence } from "./m0-evidence.mjs";
import { runStep } from "./process.mjs";
import { writeAtomicJson } from "./report.mjs";
import { hashFile } from "./source.mjs";

/** Independently frozen Canvas draws exercise the atlas compositor before project routing. */
export async function runNativeGlyphGate(context, binary, execute = runStep) {
  const report = { status: "failed", native_text_acceptance: false, frames: [] };
  const reader = new M0Evidence(context.root);
  const local = (path) => relative(context.root, path).replaceAll("\\", "/");
  try {
    await mkdir(context.output, { recursive: true });
    report.binary = { path: local(binary), sha256: await hashFile(binary) };
    const ledger = await reader.json("docs/migration/rust-renderer-progress.json");
    const pinned = ledger.reference_baseline.native_glyph_composite;
    assert(pinned, "Glyph compositor reference must be pinned independently of comparison");
    const manifest = await reader.json(pinned.path, pinned.sha256);
    const base = "tests/parity/native-glyph-composite";
    await reader.bytes(`${base}/capture.cjs`, manifest.capture_sha256);
    const fixture = await reader.json(`${base}/fixture.data`, manifest.fixture_sha256);
    assert.deepEqual(manifest.color_probe, [127, 0, 128, 255]);
    assert.equal(manifest.context.colorSpace, "srgb");
    assert.equal(manifest.context.colorType, "unorm8");
    assert.deepEqual(
      manifest.cases.map((c) => c.id),
      ["fill", "overlap", "transforms", "stroke", "color", "fractional"],
    );
    assert.deepEqual(
      fixture.cases.map((c) => c.id),
      manifest.cases.map((c) => c.id),
    );
    for (const item of manifest.cases) {
      assert.equal(item.path, `${item.id}.rgba`);
      const reference = await reader.bytes(`${base}/${item.path}`, item.sha256);
      assert.equal(reference.bytes.length, fixture.width * fixture.height * 4);
    }
    report.gpu = await execute(
      {
        id: "native-glyph-gpu",
        file: "cargo",
        args: [
          "test",
          "-p",
          "aster-renderer",
          "native_glyph_gpu_composition_and_lifetimes",
          "--",
          "--ignored",
        ],
        env: { ASTER_GLYPH_GPU_OUTPUT: context.output },
      },
      context,
    );
    assert.equal(report.gpu.status, "passed");
    for (const item of manifest.cases) {
      const raw = await reader.bytes(local(join(context.output, item.path)));
      assert.equal(raw.bytes.length, fixture.width * fixture.height * 4);
      const original = await reader.bytes(`${base}/${item.path}`, item.sha256);
      const candidate = join(context.output, `${item.id}.png`);
      const reference = join(context.output, `${item.id}-reference.png`);
      await writeFile(candidate, encodeRgbaPng(fixture.width, fixture.height, raw.bytes), {
        flag: "wx",
      });
      await writeFile(reference, encodeRgbaPng(fixture.width, fixture.height, original.bytes), {
        flag: "wx",
      });
      const caseId = `native-glyph-${item.id}`,
        output = join(context.output, item.id),
        ctx = `${output}.context.json`;
      await writeAtomicJson(ctx, { case_id: caseId, isolated: true, background: [0, 0, 0, 0] });
      const step = await execute(
        {
          id: `compare-glyph-${item.id}`,
          file: binary,
          args: [
            "compare",
            "--reference",
            reference,
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
      const result = await reader.json(local(join(output, "report.json")));
      assert.equal(result.comparison.reference_rgba_sha256, item.sha256);
      assert.equal(result.comparison.candidate_rgba_sha256, raw.sha256);
      report.frames.push({
        case_id: caseId,
        frame: 0,
        comparison: result.comparison,
        evidence: local(join(output, "report.json")),
        step,
      });
      assert.equal(step.status, "passed");
      assert.equal(result.comparison.passed, true);
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
    assert.equal(await hashFile(binary), report.binary.sha256, "Glyph comparator binary changed");
    report.checked_files = await reader.stable();
    report.status = "passed";
  } catch (error) {
    report.error = error.stack ?? String(error);
  }
  await writeAtomicJson(join(context.output, "report.json"), report);
  return report;
}
