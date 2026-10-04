import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { sourceProvenance } from "../migration/source.mjs";
import { digest } from "../parity/provenance.mjs";
import { performanceEligibility } from "./eligibility.mjs";
import { loadHistoricalBundle } from "./historical-bundle.mjs";
import { historicalBundleFixture } from "./historical-bundle-fixture.mjs";
import { auditPerformanceMeasurement, loadThroughputBaseline } from "./measurement-audit.mjs";
import { measurementFixture } from "./measurement-fixtures.mjs";
import { freezePerformanceSeries, loadPerformanceSeries } from "./performance-series.mjs";
import { auditPreviewBaseline, freezePreviewBaseline } from "./preview-baseline.mjs";

const ledgerPath = "docs/migration/rust-renderer-progress.json";
const hardwarePath = "benchmarks/hardware/windows-radeon780m-local-1920x1080-144hz.json";

async function legacyFixture(t) {
  const fixture = await measurementFixture(t);
  await fixture.baselinePreview();
  const frozen = await freezePreviewBaseline(fixture.root, "artifacts/preview.json");
  Object.assign(fixture.ledger.milestones[0], {
    preview_baseline_path: frozen.path,
    preview_baseline_sha256: frozen.sha256,
  });
  await fixture.write(ledgerPath, fixture.ledger);
  return fixture;
}

async function seriesFixture(t) {
  const fixture = await legacyFixture(t);
  await historicalBundleFixture(t, fixture.root);
  const data = await loadThroughputBaseline(fixture.root);
  const preview = await auditPreviewBaseline(fixture.root, data);
  const original = await fixture.read(data.baseline.hardware_manifest);
  const manifest = {
    ...original,
    id: "windows-radeon780m-local-1920x1080-144hz",
    parentSeries: original.id,
    capturedAt: new Date().toISOString(),
    displays: [{ ...original.displays[0], width: 1920, height: 1080, refreshHz: 144 }],
  };
  await fixture.write(hardwarePath, manifest);
  const source = await sourceProvenance(fixture.root);
  const bundle = await loadHistoricalBundle(fixture.root);
  const reports = {};
  const options = {};
  for (const suite of ["throughput", "preview"]) {
    const report = await fixture.createReport(
      suite,
      `test-new-series-${suite}`,
      undefined,
      bundle.directory,
    );
    Object.assign(report, {
      source: bundle.rendererSource,
      source_after: bundle.rendererSource,
      source_before_build: source,
      historical_execution: {
        provenance: bundle.provenance,
        harness_source_before: source,
        harness_source_after: source,
      },
      hardware: { ...report.hardware, displays: manifest.displays },
      hardware_after: { ...report.hardware_after, displays: manifest.displays },
      hardware_manifest: hardwarePath,
      hardware_manifest_sha256: digest(manifest),
    });
    report.eligibility = performanceEligibility({
      hardware: report.hardware,
      hardwareAfter: report.hardware_after,
      host: report.host,
      adapter: report.adapter,
      diagnostics: report.cases.map((item) => item.result.diagnostics),
      manifest,
      sourceUnchanged: true,
      hardwareUnchanged: true,
      diagnostic: false,
      skipped: [],
    });
    assert.equal(report.eligibility.eligible, true);
    const path = `artifacts/performance/new-series-${suite}.json`;
    await fixture.write(path, report);
    options[`${suite}ReportPath`] = path;
    reports[suite] = report;
  }
  const pin = async (path) => {
    const ledger = await fixture.read(ledgerPath);
    ledger.milestones[0].performance_series = { path, sha256: await fixture.hash(path) };
    await fixture.write(ledgerPath, ledger);
  };
  return { ...fixture, data, preview, source, bundle, manifest, reports, options, pin };
}

test("unconfigured ledgers retain both original measurement series", async (t) => {
  const fixture = await legacyFixture(t);
  const preview = await auditPreviewBaseline(fixture.root, fixture.data);
  const series = await loadPerformanceSeries(fixture.root, fixture.data, preview);
  assert.equal(series.kind, "legacy");
  assert.equal(series.baselineData, fixture.data);
  assert.deepEqual(series.throughputMeasurements, fixture.baseline.measurements);
  assert.deepEqual(series.previewMeasurements, preview.baseline.measurements);
  assert.equal(series.hardwareManifest.path, fixture.baseline.hardware_manifest);
  await series.assertStable();
});

test("additional series derives all 24 medians from authenticated 36+12 runs without changing parents", async (t) => {
  const fixture = await seriesFixture(t);
  const frozen = await freezePerformanceSeries(fixture.root, fixture.options);
  assert.equal(frozen.runs, 48);
  assert.equal(frozen.tracked_medians, 24);
  const bytes = await readFile(join(fixture.root, frozen.path));
  await assert.rejects(freezePerformanceSeries(fixture.root, fixture.options));
  assert.deepEqual(await readFile(join(fixture.root, frozen.path)), bytes);
  await fixture.pin(frozen.path);
  const series = await loadPerformanceSeries(fixture.root, fixture.data, fixture.preview);
  assert.equal(series.kind, "additional-performance-series");
  assert.equal(series.hardwareManifest.path, hardwarePath);
  assert.equal(series.baselineData.cases, fixture.data.cases);
  assert.equal(series.baselineData.outputs, fixture.data.outputs);
  for (const field of ["host", "method", "ffmpeg_sha256"])
    assert.deepEqual(series.baselineData.baseline[field], fixture.data.baseline[field]);
  assert.deepEqual(series.throughputMeasurements, fixture.reports.throughput.measurements);
  assert.deepEqual(series.previewMeasurements, fixture.reports.preview.measurements);
  assert.equal(await fixture.hash(series.baselines.throughput.path), fixture.data.sha256);
  assert.equal(await fixture.hash(series.baselines.preview.path), fixture.preview.sha256);
  for (const baseline of Object.values(series.baselines))
    assert.deepEqual(Object.keys(baseline).sort(), ["path", "sha256"]);
  await series.assertStable();

  const executable = fixture.reports.throughput.execution_artifacts.runtime.files[0].path;
  const executablePath = join(fixture.root, executable);
  const executableBytes = await readFile(executablePath);
  await writeFile(executablePath, "changed executable after historical audit");
  await assert.rejects(series.assertStable());
  await writeFile(executablePath, executableBytes);

  const output = fixture.reports.throughput.cases.find(
    (item) => item.benchmark.mode === "full-mp4",
  );
  await writeFile(output.output.encoderReport.outputPath, "changed after historical audit");
  await assert.rejects(series.assertStable(), /Historical MP4/);
});

test("self-consistent descriptor edits cannot replace audited medians, parents or full schedules", async (t) => {
  const fixture = await seriesFixture(t);
  const frozen = await freezePerformanceSeries(fixture.root, fixture.options);
  const descriptor = await fixture.read(frozen.path);
  await fixture.pin(frozen.path);

  const changed = structuredClone(descriptor);
  changed.measurements.preview[0].fps.median += 1;
  await fixture.write(frozen.path, changed);
  await fixture.pin(frozen.path);
  await assert.rejects(loadPerformanceSeries(fixture.root), /Frozen series measurements differ/);

  changed.measurements = descriptor.measurements;
  changed.parents.preview.sha256 = "e".repeat(64);
  await fixture.write(frozen.path, changed);
  await fixture.pin(frozen.path);
  await assert.rejects(loadPerformanceSeries(fixture.root), /Original baseline pins changed/);

  const incomplete = structuredClone(fixture.reports.preview);
  incomplete.cases.pop();
  await fixture.write(fixture.options.previewReportPath, incomplete);
  descriptor.reports.preview.sha256 = await fixture.hash(fixture.options.previewReportPath);
  await fixture.write(frozen.path, descriptor);
  await fixture.pin(frozen.path);
  await assert.rejects(loadPerformanceSeries(fixture.root), /Incomplete performance suite/);
});

test("the display-only authorization cannot silently change host hardware or harness provenance", async (t) => {
  const fixture = await seriesFixture(t);
  const changed = structuredClone(fixture.manifest);
  changed.operatingSystem.version = "different OS";
  await fixture.write(hardwarePath, changed);
  await assert.rejects(
    freezePerformanceSeries(fixture.root, fixture.options),
    /Only display hardware/,
  );
  await fixture.write(hardwarePath, fixture.manifest);

  const modified = structuredClone(fixture.reports.preview);
  modified.historical_execution.harness_source_after = {
    ...modified.historical_execution.harness_source_after,
    source_sha256: "f".repeat(64),
  };
  await fixture.write(fixture.options.previewReportPath, modified);
  await assert.rejects(
    freezePerformanceSeries(fixture.root, fixture.options),
    /Evidence source changed/,
  );
});

test("a real historical handle binds the renderer and cannot authorize fresh-candidate evidence", async (t) => {
  const fixture = await seriesFixture(t);
  const baselineData = {
    ...fixture.data,
    baseline: {
      ...fixture.data.baseline,
      hardware_manifest: hardwarePath,
      hardware_manifest_sha256: digest(fixture.manifest),
    },
  };
  const options = { suite: "preview", baselineData, historicalBundle: fixture.bundle };
  const changed = structuredClone(fixture.reports.preview);
  changed.source.renderer_source_sha256 = "e".repeat(64);
  changed.source_after = changed.source;
  await assert.rejects(
    auditPerformanceMeasurement(fixture.root, changed, options),
    /Historical renderer source differs/,
  );
  await assert.rejects(
    auditPerformanceMeasurement(fixture.root, fixture.reports.preview, {
      ...options,
      sourceSha256: fixture.source.source_sha256,
    }),
    /Fresh measurements cannot claim historical execution/,
  );
  const unrelated = await fixture.createReport("preview", "wrong-historical-web");
  const wrongBundle = {
    ...fixture.reports.preview,
    run_id: unrelated.run_id,
    execution_artifacts: unrelated.execution_artifacts,
  };
  await assert.rejects(
    auditPerformanceMeasurement(fixture.root, wrongBundle, options),
    /Executed browser bundle differs from the historical reference/,
  );
});
