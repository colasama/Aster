import assert from "node:assert/strict";
import { access, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { parsePerformanceArguments, reservePerformanceReport } from "./arguments.mjs";
import {
  auditPerformanceMeasurement,
  comparePerformanceMeasurements,
  performanceAssignments,
} from "./measurement-audit.mjs";
import { measurementFixture } from "./measurement-fixtures.mjs";
import { PreviewOutputSession, summarizePreview, validatePreviewResult } from "./preview.mjs";
import { auditPreviewBaseline, freezePreviewBaseline } from "./preview-baseline.mjs";

test("explicit report paths reserve fresh evidence and refuse overwrite, collisions and wrong scopes", async (t) => {
  const { root } = await measurementFixture(t);
  const args = parsePerformanceArguments(
    ["--suite", "preview", "--report", "artifacts/new.json"],
    root,
  );
  const release = await reservePerformanceReport(args.reportPath);
  await assert.rejects(reservePerformanceReport(args.reportPath), /EEXIST/);
  await writeFile(args.reportPath, "keep existing evidence");
  await release();
  await assert.rejects(reservePerformanceReport(args.reportPath), /already exists/);
  await assert.rejects(access(`${args.reportPath}.lock`));
  for (const flags of [
    ["--report", "../escape.json"],
    ["--report", "benchmarks/results/overwrite.json"],
    ["--suite", "preview", "--mode", "readback-only"],
    ["--suite", "other"],
    ["--suite", "preview", "--suite", "throughput"],
    ["--report"],
    ["--hardware-manifest", "../arbitrary.json"],
    ["--hardware-manifest", "benchmarks/hardware/other.json"],
    ["--reference-bundle", "--reference-bundle"],
    ["--reference-bundle", "--smoke"],
    ["--reference-bundle", "--case", "composite-1080p"],
  ])
    assert.throws(() => parsePerformanceArguments(flags, root));
});

test("reference execution has an explicit role and a fixed hardware-series selection", () => {
  const root = process.cwd();
  const original = parsePerformanceArguments([], root);
  assert.equal(original.referenceBundle, false);
  assert.equal(original.hardwareManifest, "benchmarks/hardware/windows-radeon780m-local.json");
  const selected = parsePerformanceArguments(
    [
      "--reference-bundle",
      "--suite",
      "preview",
      "--hardware-manifest",
      "benchmarks/hardware/windows-radeon780m-local-1920x1080-144hz.json",
    ],
    root,
  );
  assert.equal(selected.referenceBundle, true);
  assert.equal(selected.suite, "preview");
  assert.equal(
    selected.hardwareManifest,
    "benchmarks/hardware/windows-radeon780m-local-1920x1080-144hz.json",
  );
});

test("preview evidence requires twelve real assignment results and all 5,400 measured samples", async (t) => {
  const { root, data, createReport } = await measurementFixture(t);
  const report = await createReport("preview");
  const assignments = performanceAssignments(data, "preview");
  assert.equal(assignments.length, 12);
  assert.equal(assignments.filter((item) => item.benchmark.run === 0).length, 3);
  assert.deepEqual(
    [...new Set(assignments.map((item) => item.benchmark.mode))],
    ["preview-present"],
  );
  const audited = await auditPerformanceMeasurement(root, report, {
    suite: "preview",
    baselineData: data,
  });
  assert.equal(audited.measured_frames, 5400);
  assert.equal(audited.groups, 3);
  for (const mutation of [
    "missing-run",
    "missing-sample",
    "out-of-order",
    "summary",
    "input",
    "source",
    "method",
    "hardware",
    "freshness",
  ]) {
    const broken = structuredClone(report);
    const entry = broken.cases.find((item) => item.benchmark.run === 1);
    if (mutation === "missing-run") broken.cases.pop();
    if (mutation === "missing-sample") entry.result.samples.pop();
    if (mutation === "out-of-order") entry.result.samples[1].frame = 0;
    if (mutation === "summary") broken.measurements[0].fps.median += 1;
    if (mutation === "input") entry.inputs.case.size.width--;
    if (mutation === "source") broken.source_after.tree_sha256 = "f".repeat(64);
    if (mutation === "method") broken.method.scheduling = "readback";
    if (mutation === "hardware") broken.host.cacheIdentity.fonts.count--;
    if (mutation === "freshness") broken.started_at = "2000-01-01T00:00:00Z";
    await assert.rejects(
      auditPerformanceMeasurement(root, broken, {
        suite: "preview",
        baselineData: data,
        startedAfter: report.started_at,
      }),
      mutation,
    );
  }
});

test("preview rejects readback, IPC, stale GPU metrics and impossible timing instead of claiming present", async (t) => {
  const { data, createReport } = await measurementFixture(t);
  const report = await createReport("preview");
  const assignment = performanceAssignments(data, "preview")[0];
  const entry = report.cases[0];
  for (const mutate of [
    (result) => {
      result.gpuMs = 0;
    },
    (result) => {
      result.readbackWallLatenciesMs = [];
    },
    (result) => {
      result.samples[0].presentCompletionMs = -1;
    },
    (result) => {
      result.samples[0].presentCompletionMs = result.elapsedMs + 1;
    },
    (result) => {
      result.diagnostics.materialResourceError = "failed texture";
    },
  ]) {
    const result = structuredClone(entry.result);
    mutate(result);
    assert.throws(() => validatePreviewResult(assignment, result, entry.output, report.adapter));
  }
  const output = new PreviewOutputSession();
  assert.throws(() => output.output({}), /must not invoke/);
  await assert.rejects(output.verify(), /invoked/);
});

test("all eighteen throughput and six preview medians enforce the strict five percent boundary", async (t) => {
  const { baseline, createReport } = await measurementFixture(t);
  for (const suite of ["throughput", "preview"]) {
    const previous =
      suite === "throughput" ? baseline.measurements : (await createReport(suite)).measurements;
    const current = structuredClone(previous);
    const latency = suite === "throughput" ? "completion_interval_ms" : "present_completion_ms";
    for (const group of current) {
      group.fps.median *= 0.95;
      group[latency].median *= 1.05;
    }
    const atLimit = comparePerformanceMeasurements(current, previous, suite);
    assert.equal(atLimit.status, "passed");
    assert.equal(atLimit.checks.length, suite === "preview" ? 6 : 18);
    for (const metric of ["fps", latency]) {
      const failed = structuredClone(current);
      failed.at(-1)[metric].median *= metric === "fps" ? 0.9999 : 1.0001;
      assert.equal(comparePerformanceMeasurements(failed, previous, suite).status, "failed");
    }
    assert.throws(() => comparePerformanceMeasurements(current.slice(1), previous, suite));
    current[0].tracked_metrics = [];
    assert.throws(() => comparePerformanceMeasurements(current, previous, suite));
  }
});

test("pre-plan freeze publishes once, requires explicit ledger pin, and survives cloning without ignored reports", async (t) => {
  const { root, data, ledger, write, read, baselinePreview, hash } = await measurementFixture(t);
  await baselinePreview();
  const frozen = await freezePreviewBaseline(root, "artifacts/preview.json");
  assert.equal(frozen.measured_frames, 5400);
  await assert.rejects(auditPreviewBaseline(root, data), /explicitly pinned/);
  ledger.milestones[0].preview_baseline_path = frozen.path;
  ledger.milestones[0].preview_baseline_sha256 = frozen.sha256;
  await write("docs/migration/rust-renderer-progress.json", ledger);
  const audited = await auditPreviewBaseline(root, data);
  assert.equal(audited.audit.runs, 12);
  // Historical artifacts are not required by the committed self-contained baseline.
  await write("artifacts/preview.json", { deleted: true });
  assert.equal((await auditPreviewBaseline(root, data)).sha256, frozen.sha256);
  await baselinePreview();
  await assert.rejects(freezePreviewBaseline(root, "artifacts/preview.json"), /EEXIST/);
  assert.equal(await hash(frozen.path), frozen.sha256);
  const changed = await read(frozen.path);
  changed.observation.cases[0].result.samples.pop();
  await write(frozen.path, changed);
  await assert.rejects(auditPreviewBaseline(root, data), /Pinned preview baseline changed/);
});

test("pre-plan freeze rejects extraction already started, production changes and stale source", async (t) => {
  for (const mutation of ["task", "production", "source"]) {
    const { root, ledger, write, baselinePreview } = await measurementFixture(t);
    await baselinePreview();
    if (mutation === "task") {
      ledger.milestones[0].tasks[1].status = "in_progress";
      await write("docs/migration/rust-renderer-progress.json", ledger);
    } else if (mutation === "production")
      await writeFile(join(root, "src/renderer.ts"), "changed production");
    else await write("new-module.json", { source: "changed" });
    await assert.rejects(freezePreviewBaseline(root, "artifacts/preview.json"));
  }
});

test("pre-plan freeze rejects invented renderer files or bridge bytes even with the current tree hash", async (t) => {
  for (const problem of ["renderer", "bridge"]) {
    const { root, write, baselinePreview, digest } = await measurementFixture(t);
    const report = await baselinePreview();
    if (problem === "renderer")
      report.source.files = [{ path: "src/nonexistent-renderer.ts", sha256: "e".repeat(64) }];
    else report.source.bridge_sha256 = "d".repeat(64);
    report.source.renderer_source_sha256 = digest({
      files: report.source.files,
      bridge_sha256: report.source.bridge_sha256,
    });
    report.source_after = structuredClone(report.source);
    await write("artifacts/preview.json", report);
    await assert.rejects(
      freezePreviewBaseline(root, "artifacts/preview.json"),
      /Renderer source differs from current capture/,
    );
  }
});

test("throughput audit requires the full fresh series and ties encoder bytes to this run", async (t) => {
  const { root, data, createReport } = await measurementFixture(t);
  const report = await createReport("throughput");
  const audited = await auditPerformanceMeasurement(root, report, {
    suite: "throughput",
    baselineData: data,
  });
  assert.equal(audited.runs, 36);
  assert.equal(audited.measured_frames, 14526);
  const encoded = report.cases.find((item) => item.benchmark.mode === "full-mp4");
  await writeFile(encoded.output.encoderReport.outputPath, "different bytes same?");
  await assert.rejects(
    auditPerformanceMeasurement(root, report, { suite: "throughput", baselineData: data }),
  );
  report.cases.pop();
  await assert.rejects(
    auditPerformanceMeasurement(root, report, { suite: "throughput", baselineData: data }),
    /Incomplete/,
  );
  assert.throws(() => summarizePreview([], performanceAssignments(data, "preview")), /Incomplete/);
});
