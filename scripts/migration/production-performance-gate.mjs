import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { runPreviewPerformanceGate } from "./preview-performance-gate.mjs";
import { runStep } from "./process.mjs";
import { runProjectPerformanceGate } from "./project-paired-performance.mjs";
import { writeAtomicJson } from "./report.mjs";
import { hashFile, sourceProvenance } from "./source.mjs";

/** Final throughput requires both production paths, with independent preview latency acceptance. */
export async function runProductionPerformanceGate(context, execute = runStep, dependencies = {}) {
  const provenance = dependencies.provenance ?? sourceProvenance,
    started = Date.now();
  const report = {
    id: "G4",
    kind: "production-export-and-preview-performance",
    status: "failed",
    full_coverage: false,
    native_preview_acceptance: false,
    evidence: {},
  };
  try {
    report.source = await provenance(context.root);
    assert.equal(report.source.source_sha256, context.source.source_sha256);
    const parts = [
      ["export", dependencies.runProjectPerformanceGate ?? runProjectPerformanceGate],
      ["preview", dependencies.runPreviewPerformanceGate ?? runPreviewPerformanceGate],
    ];
    for (const [name, run] of parts) {
      const output = join(context.output, name),
        path = join(output, "report.json");
      const part = await run({ ...context, output }, execute);
      report[name] = part;
      assert.equal(part.id, "G4");
      assert.equal(part.status, "passed", part.error ?? `${name} performance failed`);
      assert.equal(part.source_unchanged, true);
      for (const source of [part.source, part.source_after])
        for (const key of ["source_sha256", "execution_sha256"])
          assert.equal(source[key], report.source[key]);
      if (name === "export") {
        assert.equal(part.kind, "paired-authored-project-exports");
        assert.equal(part.smoke, false);
        assert.equal(part.full_coverage, true);
        assert.equal(part.execution_complete, true);
        assert.equal(part.higher_native_median_fps, true);
      } else {
        assert.equal(part.native_preview_acceptance, true);
        assert.equal(part.throughput_passed, true);
        assert.equal(part.latency.status, "passed");
        assert.equal(part.arms.length, 6);
        assert.equal(part.rounds.length, 3);
        assert.equal(part.comparisons.length, 7);
      }
      assert.deepEqual(JSON.parse(await readFile(path, "utf8")), part);
      report.evidence[name] = {
        path: relative(context.root, path).replaceAll("\\", "/"),
        sha256: await hashFile(path),
      };
    }
    // Recompilation between suites must still yield the same production renderer binary.
    const nativeCli = report.export.native_binaries.find((file) =>
      file.path.endsWith("/aster-render-cli.exe"),
    );
    const previewCli = report.preview.binaries.find((file) =>
      file.path.endsWith("/release/aster-render-cli.exe"),
    );
    assert(nativeCli && previewCli);
    assert.equal(nativeCli.sha256, previewCli.sha256);
    const conditions = ({ capturedAt: _time, ...value }) => value;
    for (const hardware of [
      report.export.hardware_after,
      report.preview.hardware,
      report.preview.hardware_after,
    ])
      assert.deepEqual(conditions(hardware), conditions(report.export.hardware));
    for (const pin of [nativeCli, previewCli, ...Object.values(report.evidence)])
      assert.equal(await hashFile(join(context.root, pin.path)), pin.sha256);
    report.source_after = await provenance(context.root);
    report.source_unchanged = report.source.source_sha256 === report.source_after.source_sha256;
    assert(report.source_unchanged);
    report.full_coverage = true;
    report.native_preview_acceptance = true;
    report.status = "passed";
  } catch (error) {
    report.error = error.stack ?? String(error);
  }
  report.duration_ms = Date.now() - started;
  await writeAtomicJson(join(context.output, "report.json"), report);
  return report;
}
