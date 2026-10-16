import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { captureExecutionArtifacts } from "./execution-artifacts.mjs";
import { loadHistoricalBundle } from "./historical-bundle.mjs";
import { historicalBundleFixture } from "./historical-bundle-fixture.mjs";
import { loadRetainedPerformanceRuntime } from "./retained-runtime.mjs";

async function fixture(t) {
  const f = await historicalBundleFixture(t);
  const browser = await loadHistoricalBundle(f.root);
  for (const name of [
    "electron/asset-protocol.js",
    "electron/gpu-memory.js",
    "electron/local-file-response.js",
    "electron/mp4-export.js",
    "src/desktop/preferences.js",
  ])
    await f.bytes(`dist-electron/${name}`, `// Retained CPU test stub: ${name}\n`);
  await mkdir(join(f.root, "artifacts/performance/retained-runtime"), { recursive: true });
  const runtime = await captureExecutionArtifacts(f.root, {
    webDirectory: join(f.root, f.directory),
    runDirectory: join(f.root, "artifacts/performance/retained-runtime"),
  });
  const reportPath = "artifacts/performance/retained-runtime/report.json";
  const harness = { fixture: "current common harness" };
  await f.write(reportPath, {
    status: "passed",
    baseline_eligible: true,
    source_unchanged: true,
    source: browser.rendererSource,
    source_after: browser.rendererSource,
    historical_execution: {
      provenance: browser.provenance,
      harness_source_before: harness,
      harness_source_after: harness,
    },
    execution_artifacts: runtime.snapshot,
  });
  const seriesPath = "benchmarks/results/m2-performance-1920x1080-144hz.json";
  await f.write(seriesPath, {
    status: "passed",
    historical_reference: browser.provenance,
    harness_source: harness,
    reports: { throughput: { path: reportPath, sha256: await f.hash(reportPath) } },
  });
  const task = f.ledger.milestones
    .find((m) => m.id === "M2")
    .tasks.find((item) => item.id === "M2-T1");
  task.performance_evidence = {
    baselines: { series: { path: seriesPath, sha256: await f.hash(seriesPath) } },
  };
  await f.write(f.ledgerPath, f.ledger);
  return { ...f, runtime: runtime.snapshot };
}

test("retained execution ignores candidate Electron/bridge changes and freezes its evidence handle", async (t) => {
  const f = await fixture(t);
  await f.bytes("dist-electron/electron/mp4-export.js", "// Different candidate encoder\n");
  await f.bytes("target/release/aster-desktop-bridge.exe", "different candidate bridge");
  const handle = await loadRetainedPerformanceRuntime(f.root);
  assert(handle.runtimeDirectory.includes("artifacts"));
  assert.equal(handle.provenance.bridge.sha256, f.source.bridge_sha256);
  assert.throws(() => {
    handle.runtimeDirectory = join(f.root, "dist-electron");
  }, TypeError);
  assert.throws(() => {
    handle.provenance.execution_artifacts.runtime.files[0].sha256 = "0".repeat(64);
  }, TypeError);
  await handle.assertStable();
});

test("mutated preserved Electron bytes reject both fresh loading and post-execution audit", async (t) => {
  const f = await fixture(t);
  const handle = await loadRetainedPerformanceRuntime(f.root);
  const member = f.runtime.runtime.files.find((file) =>
    file.path.endsWith("/electron/mp4-export.js"),
  );
  await f.bytes(member.path, "// Substituted candidate encoder\n");
  await assert.rejects(handle.assertStable(), /file set or bytes changed/);
  await assert.rejects(loadRetainedPerformanceRuntime(f.root), /file set or bytes changed/);
});
