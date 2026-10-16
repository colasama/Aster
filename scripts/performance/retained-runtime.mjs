import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import { M0Evidence } from "../migration/m0-evidence.mjs";
import { auditExecutionArtifacts } from "./execution-artifacts.mjs";
import { loadHistoricalBundle } from "./historical-bundle.mjs";

function freeze(value) {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

/** Authenticate the saved browser, Electron and bridge bytes without consulting candidate builds. */
export async function loadRetainedPerformanceRuntime(root) {
  root = resolve(root);
  const reader = new M0Evidence(root);
  const ledger = await reader.json("docs/migration/rust-renderer-progress.json");
  const task = ledger.milestones.find((m) => m.id === "M2")?.tasks.find((t) => t.id === "M2-T1");
  const pin = task?.performance_evidence?.baselines?.series;
  assert.equal(pin?.path, "benchmarks/results/m2-performance-1920x1080-144hz.json");
  const series = await reader.json(pin.path, pin.sha256);
  assert.equal(series.status, "passed");
  const browser = await loadHistoricalBundle(root);
  assert.deepEqual(series.historical_reference, browser.provenance);
  const reportPin = series.reports.throughput;
  const origin = await reader.json(reportPin.path, reportPin.sha256);
  assert.equal(origin.status, "passed");
  assert.equal(origin.baseline_eligible, true);
  assert.equal(origin.source_unchanged, true);
  assert.deepEqual(origin.historical_execution?.harness_source_before, series.harness_source);
  assert.deepEqual(origin.historical_execution?.harness_source_after, series.harness_source);
  assert.deepEqual(origin.historical_execution.provenance, browser.provenance);
  assert.deepEqual(origin.source, browser.rendererSource);
  assert.deepEqual(origin.source_after, origin.source);
  const execution = origin.execution_artifacts;
  await auditExecutionArtifacts(root, execution);
  assert.deepEqual(execution.web, browser.provenance.bundle);
  const bridge = execution.runtime.files.find((file) =>
    file.path.endsWith("/bridge/aster-desktop-bridge.exe"),
  );
  assert(bridge, "Retained bridge is missing");
  assert.equal(bridge.sha256, browser.provenance.bridge.sha256);
  const runtimeDirectory = join(root, execution.runtime.directory, "dist-electron");
  const modules = [
    "electron/asset-protocol.js",
    "electron/gpu-memory.js",
    "electron/local-file-response.js",
    "electron/mp4-export.js",
    "src/desktop/preferences.js",
  ];
  for (const module of modules)
    assert(
      execution.runtime.files.some(
        (file) => file.path === `${execution.runtime.directory}/dist-electron/${module}`,
      ),
      `Retained runtime module is missing: ${module}`,
    );
  const assertStable = async () => {
    await reader.stable();
    await browser.assertStable();
    await auditExecutionArtifacts(root, execution);
  };
  await assertStable();
  return Object.freeze({
    browser,
    runtimeDirectory,
    bridgePath: join(root, bridge.path),
    provenance: freeze({
      kind: "independently-retained-ts-runtime",
      series: pin,
      report: reportPin,
      historical_browser: browser.provenance,
      execution_artifacts: execution,
      bridge,
    }),
    assertStable,
  });
}
