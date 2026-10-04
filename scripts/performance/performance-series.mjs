import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { link, mkdir, open, rm, stat } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { evidencePath, M0Evidence, validSha } from "../migration/m0-evidence.mjs";
import { hashFile, sourceProvenance } from "../migration/source.mjs";
import { digest } from "../parity/provenance.mjs";
import { auditExecutionArtifacts } from "./execution-artifacts.mjs";
import { loadHistoricalBundle } from "./historical-bundle.mjs";
import { auditPerformanceMeasurement, loadThroughputBaseline } from "./measurement-audit.mjs";
import { auditPreviewBaseline } from "./preview-baseline.mjs";

const seriesPath = "benchmarks/results/m2-performance-1920x1080-144hz.json";
const hardwarePath = "benchmarks/hardware/windows-radeon780m-local-1920x1080-144hz.json";
const hardwareId = "windows-radeon780m-local-1920x1080-144hz";

async function parents(root, reader, data, preview) {
  data ??= await loadThroughputBaseline(root);
  preview ??= await auditPreviewBaseline(root, data);
  const paths = {
    throughput: { path: "benchmarks/results/migration-baseline.json", sha256: data.sha256 },
    preview: { path: "benchmarks/results/m2-preview-baseline.json", sha256: preview.sha256 },
  };
  assert.equal(preview.path, paths.preview.path);
  assert.deepEqual(
    await reader.json(paths.throughput.path, paths.throughput.sha256),
    data.baseline,
  );
  assert.deepEqual(await reader.json(paths.preview.path, paths.preview.sha256), preview.baseline);
  assert.equal(preview.baseline.throughput_baseline_sha256, data.sha256);
  const ledger = await reader.json("docs/migration/rust-renderer-progress.json");
  const milestone = ledger.milestones.find((item) => item.id === "M2");
  assert(milestone, "M2 performance policy is missing");
  assert.equal(milestone.preview_baseline_path, paths.preview.path);
  assert.equal(milestone.preview_baseline_sha256, paths.preview.sha256);
  return { data, preview, paths, ledger, milestone };
}

async function hardwareSeries(reader, data) {
  const original = await reader.json(data.baseline.hardware_manifest);
  assert.equal(digest(original), data.baseline.hardware_manifest_sha256);
  assert.equal(original.id, "windows-radeon780m-local");
  assert.equal(original.baselinePolicy.driverOsPowerDisplayChangesStartNewSeries, true);
  const file = await reader.bytes(hardwarePath);
  const value = await reader.json(hardwarePath);
  assert.equal(value.id, hardwareId);
  assert.equal(value.parentSeries, original.id);
  assert(Number.isFinite(Date.parse(value.capturedAt)), "New hardware capture time is missing");
  const unchanged = ({
    id: _id,
    parentSeries: _parent,
    capturedAt: _time,
    displays: _displays,
    ...rest
  }) => rest;
  assert.deepEqual(
    unchanged(value),
    unchanged(original),
    "Only display hardware and series identity may change",
  );
  assert.deepEqual(
    value.displays,
    [{ ...original.displays[0], width: 1920, height: 1080, refreshHz: 144 }],
    "The additional series requires the fixed 1920x1080 144 Hz display",
  );
  assert.equal(original.displays.length, 1);
  const hardwareManifest = {
    path: hardwarePath,
    sha256: file.sha256,
    content_sha256: digest(value),
    value,
  };
  return {
    hardwareManifest,
    baselineData: {
      ...data,
      baseline: {
        ...data.baseline,
        hardware_manifest: hardwarePath,
        hardware_manifest_sha256: digest(value),
      },
    },
  };
}

async function auditReports(root, reader, descriptor, data, bundle) {
  assert.deepEqual(descriptor.historical_reference, bundle.provenance);
  const audits = {};
  const runIds = new Set();
  for (const suite of ["throughput", "preview"]) {
    const evidence = descriptor.reports[suite];
    evidencePath(evidence.path);
    validSha(evidence.sha256);
    assert(
      evidence.path.startsWith("artifacts/performance/"),
      "Series reports must be actual performance artifacts",
    );
    const report = await reader.json(evidence.path, evidence.sha256);
    assert.equal(report.run_id, evidence.run_id);
    assert(!runIds.has(report.run_id), "Each performance suite requires an independent run");
    runIds.add(report.run_id);
    assert.deepEqual(report.historical_execution?.harness_source_before, descriptor.harness_source);
    audits[suite] = await auditPerformanceMeasurement(root, report, {
      suite,
      baselineData: data,
      historicalBundle: bundle,
    });
    assert.equal(audits[suite].runs, suite === "throughput" ? 36 : 12);
    assert.equal(audits[suite].groups, suite === "throughput" ? 9 : 3);
    if (descriptor.measurements !== undefined)
      assert.deepEqual(
        descriptor.measurements[suite],
        audits[suite].measurements,
        "Frozen series measurements differ from audited raw observations",
      );
  }
  return audits;
}

async function stableEvidence(root, reader, bundle, audits) {
  await reader.stable();
  if (bundle) await bundle.assertStable();
  for (const audit of Object.values(audits)) {
    await auditExecutionArtifacts(root, audit.executionArtifacts);
    for (const output of audit.actualOutputs) {
      const path = join(root, output.path);
      assert.equal(
        (await stat(path)).size,
        output.bytes,
        "Historical MP4 size changed after audit",
      );
      assert.equal(await hashFile(path), output.sha256, "Historical MP4 bytes changed after audit");
    }
  }
}

/** Existing ledgers retain their original series; configured additions require all raw evidence. */
export async function loadPerformanceSeries(root, baselineData, previewBaseline) {
  root = resolve(root);
  const reader = new M0Evidence(root);
  const parent = await parents(root, reader, baselineData, previewBaseline);
  const pin = parent.milestone.performance_series;
  if (pin === undefined) {
    const file = await reader.bytes(parent.data.baseline.hardware_manifest);
    const value = await reader.json(parent.data.baseline.hardware_manifest);
    assert.equal(digest(value), parent.data.baseline.hardware_manifest_sha256);
    await reader.stable();
    return {
      kind: "legacy",
      hardwareManifest: {
        path: parent.data.baseline.hardware_manifest,
        sha256: file.sha256,
        content_sha256: digest(value),
        value,
      },
      baselineData: parent.data,
      throughputMeasurements: parent.data.baseline.measurements,
      previewMeasurements: parent.preview.baseline.measurements,
      baselines: parent.paths,
      assertStable: () => reader.stable(),
    };
  }
  assert.equal(pin?.path, seriesPath, "Unknown additional performance series");
  validSha(pin.sha256);
  const descriptor = await reader.json(seriesPath, pin.sha256);
  assert.equal(descriptor.schema_version, 1);
  assert.equal(descriptor.kind, "additional-performance-series");
  assert.equal(descriptor.status, "passed");
  assert.equal(descriptor.id, hardwareId);
  assert.deepEqual(Object.keys(descriptor.measurements).sort(), ["preview", "throughput"]);
  assert.deepEqual(descriptor.parents, parent.paths, "Original baseline pins changed");
  const selected = await hardwareSeries(reader, parent.data);
  const { value: _value, ...manifestEvidence } = selected.hardwareManifest;
  assert.deepEqual(descriptor.hardware_manifest, manifestEvidence);
  const bundle = await loadHistoricalBundle(root);
  const audits = await auditReports(root, reader, descriptor, selected.baselineData, bundle);
  const assertStable = () => stableEvidence(root, reader, bundle, audits);
  await assertStable();
  return {
    kind: descriptor.kind,
    ...selected,
    throughputMeasurements: audits.throughput.measurements,
    previewMeasurements: audits.preview.measurements,
    baselines: {
      ...parent.paths,
      series: { path: seriesPath, sha256: pin.sha256 },
      hardware_manifest: {
        path: selected.hardwareManifest.path,
        sha256: selected.hardwareManifest.sha256,
      },
    },
    assertStable,
  };
}

/** Publish once from fresh complete historical-reference measurements; never accepts manual medians. */
export async function freezePerformanceSeries(root, { throughputReportPath, previewReportPath }) {
  root = resolve(root);
  const reader = new M0Evidence(root);
  const parent = await parents(root, reader);
  assert.equal(parent.ledger.status, "running");
  assert.equal(parent.milestone.status, "in_progress");
  assert.equal(
    parent.milestone.performance_series,
    undefined,
    "An additional series is already selected",
  );
  const source = await sourceProvenance(root);
  const selected = await hardwareSeries(reader, parent.data);
  const bundle = await loadHistoricalBundle(root);
  const reports = {};
  for (const [suite, input] of [
    ["throughput", throughputReportPath],
    ["preview", previewReportPath],
  ]) {
    assert.equal(typeof input, "string");
    const path = evidencePath(relative(root, resolve(root, input)).replaceAll("\\", "/"));
    const file = await reader.bytes(path);
    const report = await reader.json(path);
    assert.deepEqual(
      report.historical_execution?.harness_source_before,
      source,
      "Additional series must use the current unchanged harness source",
    );
    reports[suite] = { path, sha256: file.sha256, run_id: report.run_id };
  }
  const { value: _value, ...manifestEvidence } = selected.hardwareManifest;
  const descriptor = {
    schema_version: 1,
    kind: "additional-performance-series",
    status: "passed",
    id: hardwareId,
    created_at: new Date().toISOString(),
    parents: parent.paths,
    hardware_manifest: manifestEvidence,
    historical_reference: bundle.provenance,
    harness_source: source,
    reports,
  };
  const audits = await auditReports(root, reader, descriptor, selected.baselineData, bundle);
  descriptor.measurements = {
    throughput: audits.throughput.measurements,
    preview: audits.preview.measurements,
  };
  await stableEvidence(root, reader, bundle, audits);
  assert.deepEqual(
    await sourceProvenance(root),
    source,
    "Source changed while freezing the additional series",
  );
  const target = join(root, seriesPath);
  await mkdir(dirname(target), { recursive: true });
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    const file = await open(temporary, "wx");
    try {
      await file.writeFile(`${JSON.stringify(descriptor, null, 2)}\n`);
      await file.sync();
    } finally {
      await file.close();
    }
    await link(temporary, target);
  } finally {
    await rm(temporary, { force: true });
  }
  return {
    status: "passed",
    path: seriesPath,
    sha256: await hashFile(target),
    groups: 12,
    runs: 48,
    tracked_medians: 24,
  };
}
