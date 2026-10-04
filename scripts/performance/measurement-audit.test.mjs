import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { captureSource } from "../parity/provenance.mjs";
import { auditPerformanceMeasurement } from "./measurement-audit.mjs";
import { measurementFixture } from "./measurement-fixtures.mjs";

test("fresh candidates cannot borrow a historical execution role", async (t) => {
  const fixture = await measurementFixture(t);
  const report = await fixture.createReport("preview");
  const source = await captureSource(fixture.root);
  report.historical_execution = {
    provenance: {},
    harness_source_before: {},
    harness_source_after: {},
  };
  await assert.rejects(
    auditPerformanceMeasurement(fixture.root, report, {
      suite: "preview",
      baselineData: fixture.data,
      sourceSha256: source.tree_sha256,
      expectedRendererSource: source,
    }),
    /Fresh measurements cannot claim historical execution/,
  );
});

test("self-declared history and forged bundle handles are rejected", async (t) => {
  const fixture = await measurementFixture(t);
  const report = await fixture.createReport("preview");
  report.historical_execution = {
    provenance: {},
    harness_source_before: {},
    harness_source_after: {},
  };
  await assert.rejects(
    auditPerformanceMeasurement(fixture.root, report, {
      suite: "preview",
      baselineData: fixture.data,
    }),
    /trusted bundle handle/,
  );
  await assert.rejects(
    auditPerformanceMeasurement(fixture.root, report, {
      suite: "preview",
      baselineData: fixture.data,
      historicalBundle: {
        provenance: {},
        rendererSource: report.source,
        assertStable: async () => {},
      },
    }),
  );
});

test("fresh measurements require the actual preserved execution artifacts", async (t) => {
  const fixture = await measurementFixture(t);
  const report = await fixture.createReport("preview");
  const source = await captureSource(fixture.root);
  const options = {
    suite: "preview",
    baselineData: fixture.data,
    sourceSha256: source.tree_sha256,
    expectedRendererSource: source,
  };
  assert.equal((await auditPerformanceMeasurement(fixture.root, report, options)).status, "passed");
  const missing = structuredClone(report);
  delete missing.execution_artifacts;
  await assert.rejects(
    auditPerformanceMeasurement(fixture.root, missing, options),
    /execution artifacts are required/,
  );
  const otherRun = structuredClone(report);
  otherRun.execution_artifacts.run_directory = "artifacts/performance/another-run";
  await assert.rejects(auditPerformanceMeasurement(fixture.root, otherRun, options));
  const independent = await fixture.createReport("preview", "independent-valid-web");
  const borrowedWeb = structuredClone(report);
  borrowedWeb.execution_artifacts.web = independent.execution_artifacts.web;
  await assert.rejects(
    auditPerformanceMeasurement(fixture.root, borrowedWeb, options),
    /Fresh measurements must execute their own newly built web bundle/,
  );
  const runtimeFile = report.execution_artifacts.runtime.files[0].path;
  await writeFile(join(fixture.root, runtimeFile), "altered actual executable");
  await assert.rejects(auditPerformanceMeasurement(fixture.root, report, options));
});
