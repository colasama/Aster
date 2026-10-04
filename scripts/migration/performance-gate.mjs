import assert from "node:assert/strict";
import { mkdir, mkdtemp, stat } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { captureSource } from "../parity/provenance.mjs";
import { auditExecutionArtifacts } from "../performance/execution-artifacts.mjs";
import {
  auditPerformanceMeasurement,
  comparePerformanceMeasurements,
  loadThroughputBaseline,
} from "../performance/measurement-audit.mjs";
import { loadPerformanceSeries } from "../performance/performance-series.mjs";
import { auditPreviewBaseline } from "../performance/preview-baseline.mjs";
import { M0Evidence } from "./m0-evidence.mjs";
import { runStep } from "./process.mjs";
import { writeAtomicJson } from "./report.mjs";
import { hashFile, sourceProvenance } from "./source.mjs";

export async function runPerformanceGate(context, execute = runStep) {
  const started = new Date();
  const root = resolve(context.root);
  await mkdir(context.output, { recursive: true });
  const output = await mkdtemp(join(context.output, "performance-"));
  const pathOf = (path) => relative(root, path).replaceAll("\\", "/");
  const gate = {
    id: "G4",
    status: "failed",
    started_at: started.toISOString(),
    steps: [],
    suites: [],
  };
  try {
    gate.source = await sourceProvenance(root);
    if (context.source)
      assert.equal(
        gate.source.source_sha256,
        context.source.source_sha256,
        "G4 source differs from verifier",
      );
    const data = await loadThroughputBaseline(root);
    const preview = await auditPreviewBaseline(root, data);
    const series = await loadPerformanceSeries(root, data, preview);
    gate.baselines = series.baselines;
    gate.comparison_series = {
      kind: series.kind,
      hardware_manifest: series.hardwareManifest.path,
      ...(series.baselines.series ? { descriptor: series.baselines.series } : {}),
    };
    const reader = new M0Evidence(root);
    let rendererSource;
    for (const suite of ["throughput", "preview"]) {
      const reportPath = join(output, `${suite}.json`);
      const step = await execute(
        {
          id: `performance-${suite}`,
          file: "node",
          args: [
            "scripts/performance-baseline.mjs",
            "--suite",
            suite,
            "--report",
            reportPath,
            "--hardware-manifest",
            series.hardwareManifest.path,
          ],
          timeout_ms: 7_200_000,
        },
        { ...context, root, output },
      );
      gate.steps.push(step);
      assert.equal(step.status, "passed", `Performance ${suite} process failed`);
      assert.equal(step.exit_code, 0);
      const file = await reader.bytes(pathOf(reportPath));
      const report = await reader.json(pathOf(reportPath));
      const currentRendererSource = await captureSource(root);
      if (rendererSource !== undefined)
        assert.deepEqual(
          currentRendererSource,
          rendererSource,
          "Renderer or bridge changed between performance suites",
        );
      rendererSource = currentRendererSource;
      const audited = await auditPerformanceMeasurement(root, report, {
        suite,
        baselineData: series.baselineData,
        sourceSha256: gate.source.source_sha256,
        startedAfter: gate.started_at,
        expectedRendererSource: currentRendererSource,
      });
      if (suite === "preview")
        assert.notEqual(
          report.run_id,
          preview.baseline.observation.run_id,
          "Preview cannot compare its baseline run to itself",
        );
      const comparison = comparePerformanceMeasurements(
        audited.measurements,
        suite === "preview" ? series.previewMeasurements : series.throughputMeasurements,
        suite,
      );
      gate.suites.push({
        suite,
        report: { path: pathOf(reportPath), sha256: file.sha256 },
        audit: audited,
        status: comparison.status,
        checks: comparison.checks,
      });
    }
    await reader.stable();
    await series.assertStable();
    assert.deepEqual(
      await captureSource(root),
      rendererSource,
      "Renderer or bridge changed during G4",
    );
    gate.renderer_source = rendererSource;
    for (const suite of gate.suites) {
      await auditExecutionArtifacts(root, suite.audit.executionArtifacts);
      for (const file of suite.audit.actualOutputs) {
        const path = join(root, file.path);
        assert.equal((await stat(path)).size, file.bytes, "Measured MP4 size changed after audit");
        assert.equal(await hashFile(path), file.sha256, "Measured MP4 bytes changed after audit");
      }
    }
    assert.equal(await hashFile(join(root, gate.baselines.throughput.path)), data.sha256);
    assert.equal(await hashFile(join(root, gate.baselines.preview.path)), preview.sha256);
    gate.source_after = await sourceProvenance(root);
    assert.equal(
      gate.source.source_sha256,
      gate.source_after.source_sha256,
      "Source changed during G4",
    );
    assert.equal(
      gate.suites.reduce((count, suite) => count + suite.checks.length, 0),
      24,
    );
    gate.status = gate.suites.every((suite) => suite.status === "passed") ? "passed" : "failed";
  } catch (error) {
    gate.error = error.stack ?? String(error);
  }
  gate.finished_at = new Date().toISOString();
  gate.duration_ms = Date.now() - started.getTime();
  const reportPath = join(output, "gate.json");
  await writeAtomicJson(reportPath, gate);
  return { ...gate, report_path: pathOf(reportPath), report_sha256: await hashFile(reportPath) };
}
