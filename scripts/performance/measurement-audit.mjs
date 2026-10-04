import assert from "node:assert/strict";
import { stat } from "node:fs/promises";
import { basename, relative, resolve } from "node:path";
import { evidencePath, M0Evidence, stableSource, validSha } from "../migration/m0-evidence.mjs";
import { hashFile } from "../migration/source.mjs";
import { digest } from "../parity/provenance.mjs";
import { validateCommittedBaseline } from "./baseline.mjs";
import { performanceEligibility } from "./eligibility.mjs";
import { auditExecutionArtifacts } from "./execution-artifacts.mjs";
import { assertHistoricalBundle } from "./historical-bundle.mjs";
import { validatePerformanceResult, validateProbe } from "./output-session.mjs";
import { previewMethod, summarizePreview, validatePreviewResult } from "./preview.mjs";
import { summarizePerformance } from "./statistics.mjs";
import { schedulePreviewWorkloads, scheduleWorkloads } from "./workloads.mjs";

export async function loadThroughputBaseline(root) {
  await validateCommittedBaseline(root);
  const reader = new M0Evidence(root);
  const path = "benchmarks/results/migration-baseline.json";
  const file = await reader.bytes(path);
  const baseline = await reader.json(path);
  const cases = new Map();
  const outputs = new Map();
  for (const measurement of baseline.measurements) {
    const raw = await reader.json(measurement.raw_data, measurement.raw_data_sha256);
    cases.set(measurement.case_id, raw[0].inputs);
    outputs.set(`${measurement.case_id}/${measurement.mode}`, raw[0].output.encoder);
  }
  await reader.stable();
  return { baseline, cases, outputs, sha256: file.sha256 };
}

export function performanceAssignments(data, suite) {
  const ids =
    suite === "preview"
      ? ["composite-1080p", "composite-4k", "effect-chain-1080p"]
      : ["owner-opening", "owner-main", "composite-1080p", "composite-4k", "effect-chain-1080p"];
  const workloads = ids.map((id) => {
    const inputs = data.cases.get(id);
    assert(inputs, `Pinned workload is missing: ${id}`);
    return {
      case: inputs.case,
      frames: inputs.frames,
      inputs,
      caseHash: digest(inputs),
      frameRate: { numerator: 30, denominator: 1 },
    };
  });
  return suite === "preview" ? schedulePreviewWorkloads(workloads) : scheduleWorkloads(workloads);
}

/** Audit actual raw observations against pinned inputs; never substitute baseline observations. */
export async function auditPerformanceMeasurement(
  root,
  report,
  {
    suite,
    baselineData,
    sourceSha256,
    startedAfter,
    expectedRendererSource,
    historicalBundle,
  } = {},
) {
  assert(["throughput", "preview"].includes(suite));
  const data = baselineData ?? (await loadThroughputBaseline(root));
  const baseline = data.baseline;
  const reader = new M0Evidence(root);
  assert.equal(report.schema_version, 1);
  assert.equal(report.suite, suite);
  assert.equal(report.status, "passed");
  assert.equal(report.exit_code, 0);
  assert.equal(report.diagnostic, false, "Diagnostic performance is not a full gate");
  assert.equal(report.baseline_eligible, true);
  assert.equal(report.source_unchanged, true);
  assert.equal(report.hardware_unchanged, true);
  assert.deepEqual(report.skipped, [], "Required workloads were skipped");
  assert(typeof report.run_id === "string" && /^[a-zA-Z0-9-]+$/.test(report.run_id));
  const start = Date.parse(report.started_at);
  const end = Date.parse(report.finished_at);
  assert(Number.isFinite(start) && Number.isFinite(end) && end >= start);
  if (startedAfter !== undefined)
    assert(start >= Date.parse(startedAfter), "Performance report predates this gate run");
  stableSource(report.source, report.source_after, "renderer_source_sha256");
  const historicalExecution = Object.hasOwn(report, "historical_execution");
  if (sourceSha256 !== undefined)
    assert(!historicalExecution, "Fresh measurements cannot claim historical execution");
  if (historicalBundle !== undefined) {
    assertHistoricalBundle(historicalBundle);
    await historicalBundle.assertStable();
    assert(historicalExecution, "Historical reference measurements require explicit provenance");
    assert.equal(sourceSha256, undefined, "Historical reference cannot serve as a fresh candidate");
    assert.equal(expectedRendererSource, undefined);
    assert.deepEqual(report.historical_execution.provenance, historicalBundle.provenance);
    for (const source of [report.source, report.source_after])
      assert.deepEqual(
        source,
        historicalBundle.rendererSource,
        "Historical renderer source differs from the pinned bundle",
      );
    const { harness_source_before: before, harness_source_after: after } =
      report.historical_execution;
    stableSource(before, after, "source_sha256");
    assert.deepEqual(before, after, "Historical execution harness changed during measurement");
    assert.deepEqual(
      report.source_before_build,
      before,
      "Historical build source differs from its harness",
    );
  } else {
    assert(!historicalExecution, "Historical execution requires a trusted bundle handle");
    assert.equal(report.source_before_build?.source_sha256, validSha(report.source.tree_sha256));
  }
  if (sourceSha256 !== undefined) {
    assert(
      expectedRendererSource,
      "Fresh measurements require the current renderer source snapshot",
    );
    assert.equal(
      report.source.tree_sha256,
      validSha(sourceSha256),
      "Performance used different source",
    );
  }
  for (const source of [report.source, report.source_after]) {
    assert(Array.isArray(source.files) && source.files.length > 0);
    assert.equal(new Set(source.files.map((file) => file.path)).size, source.files.length);
    for (const file of source.files) {
      evidencePath(file.path);
      validSha(file.sha256);
    }
    validSha(source.bridge_sha256);
    assert.equal(
      digest({ files: source.files, bridge_sha256: source.bridge_sha256 }),
      source.renderer_source_sha256,
    );
    if (expectedRendererSource !== undefined) {
      assert.equal(
        source.tree_sha256,
        expectedRendererSource.tree_sha256,
        "Renderer source tree differs from current capture",
      );
      for (const field of ["renderer_source_sha256", "bridge_sha256", "files"])
        assert.deepEqual(
          source[field],
          expectedRendererSource[field],
          `Renderer source differs from current capture: ${field}`,
        );
    }
  }
  const executionArtifacts = report.execution_artifacts;
  if (sourceSha256 !== undefined || historicalBundle !== undefined)
    assert(executionArtifacts, "Performance execution artifacts are required");
  if (executionArtifacts !== undefined) {
    assert.equal(executionArtifacts.run_directory, `artifacts/performance/${report.run_id}`);
    if (sourceSha256 !== undefined)
      assert.equal(
        executionArtifacts.web.directory,
        `artifacts/performance/${report.run_id}/web`,
        "Fresh measurements must execute their own newly built web bundle",
      );
    await auditExecutionArtifacts(root, executionArtifacts);
    const bridgePath = `${executionArtifacts.runtime.directory}/bridge/${basename(
      executionArtifacts.runtime.live.bridge_path,
    )}`;
    assert.equal(
      executionArtifacts.runtime.files.find((file) => file.path === bridgePath)?.sha256,
      report.source.bridge_sha256,
      "Executed bridge differs from renderer provenance",
    );
    if (historicalBundle !== undefined)
      assert.deepEqual(
        executionArtifacts.web,
        historicalBundle.provenance.bundle,
        "Executed browser bundle differs from the historical reference",
      );
  }
  assert.equal(report.hardware_manifest, baseline.hardware_manifest);
  assert.equal(report.hardware_manifest_sha256, baseline.hardware_manifest_sha256);
  const hardwareManifest = await reader.json(report.hardware_manifest);
  assert.equal(digest(hardwareManifest), report.hardware_manifest_sha256);
  assert.deepEqual(report.ffmpeg_sha256, baseline.ffmpeg_sha256, "FFmpeg binary series changed");
  assert.deepEqual(report.ffmpeg_sha256, report.ffmpeg_sha256_after);
  const host = report.host?.cacheIdentity;
  for (const field of [
    "platform",
    "architecture",
    "os_release",
    "electron",
    "chromium",
    "backend",
    "gpuPreference",
    "webgpuAdapter",
    "fonts",
    "driver",
  ])
    assert.deepEqual(host?.[field], baseline.host[field], `Performance host changed: ${field}`);
  assert.deepEqual(
    report.method,
    suite === "preview" ? previewMethod : baseline.method,
    "Performance methodology changed",
  );
  const assignments = performanceAssignments(data, suite);
  assert.equal(report.cases?.length, assignments.length, "Incomplete performance suite");
  const diagnostics = [];
  const actualOutputs = [];
  for (const [index, assignment] of assignments.entries()) {
    const entry = report.cases[index];
    assert.equal(entry.status, "passed");
    assert.equal(entry.id, assignment.benchmark.id, "Performance run order or identity changed");
    assert.equal(entry.caseId, assignment.case.id);
    assert.deepEqual(entry.benchmark, assignment.benchmark, "Workload timing policy changed");
    assert.deepEqual(
      entry.inputs,
      assignment.inputs,
      "Performance project, media or frame inputs changed",
    );
    assert.equal(entry.case_hash, assignment.caseHash);
    if (suite === "preview")
      validatePreviewResult(assignment, entry.result, entry.output, host.webgpuAdapter);
    else {
      validatePerformanceResult(assignment, entry.result, entry.output, host.webgpuAdapter);
      assert.equal(
        entry.output.encoder,
        data.outputs.get(`${assignment.case.id}/${assignment.benchmark.mode}`),
        "Actual encoder changed",
      );
      if (assignment.benchmark.mode === "full-mp4") {
        const { result, output } = entry;
        assert.equal(output.encoderReport.encoder, output.encoder);
        assert.equal(output.encoderReport.frameCount, result.frames);
        assert.equal(output.encoderReport.audioFrameCount, result.audio.frameCount);
        assert.equal(output.encoderReport.bytesWritten, output.ffprobe.bytes);
        validSha(output.ffprobe.sha256);
        validateProbe(output.ffprobe.result, {
          width: result.width,
          height: result.height,
          frameRateNumerator: result.frameRate.numerator,
          frameRateDenominator: result.frameRate.denominator,
          frameCount: result.frames,
          audio: result.audio,
        });
        const path = evidencePath(
          relative(root, resolve(output.encoderReport.outputPath)).replaceAll("\\", "/"),
        );
        assert(
          path.startsWith(`artifacts/performance/${report.run_id}/outputs/`),
          "MP4 is not from this performance run",
        );
        assert.equal((await stat(resolve(root, path))).size, output.ffprobe.bytes);
        assert.equal(
          await hashFile(resolve(root, path)),
          output.ffprobe.sha256,
          "Measured MP4 bytes changed",
        );
        actualOutputs.push({ path, sha256: output.ffprobe.sha256, bytes: output.ffprobe.bytes });
      } else assert.equal(entry.output.ffprobe, null);
    }
    diagnostics.push(entry.result.diagnostics);
  }
  const summary =
    suite === "preview"
      ? summarizePreview(report.cases, assignments)
      : summarizePerformance(report.cases, assignments, false);
  assert.deepEqual(report.measurements, summary, "Performance summary differs from raw samples");
  const eligibility = performanceEligibility({
    hardware: report.hardware,
    hardwareAfter: report.hardware_after,
    host: report.host,
    adapter: report.adapter,
    diagnostics,
    manifest: hardwareManifest,
    sourceUnchanged: true,
    hardwareUnchanged: true,
    diagnostic: false,
    skipped: [],
  });
  assert.equal(eligibility.eligible, true, eligibility.reasons.join(", "));
  assert.deepEqual(
    report.eligibility,
    eligibility,
    "Performance eligibility differs from observations",
  );
  await reader.stable();
  if (executionArtifacts !== undefined) await auditExecutionArtifacts(root, executionArtifacts);
  if (historicalBundle !== undefined) await historicalBundle.assertStable();
  return {
    status: "passed",
    suite,
    groups: summary.length,
    runs: assignments.length,
    measured_frames: summary.reduce((count, item) => count + item.frames_per_run * 3, 0),
    measurements: summary,
    actualOutputs,
    executionArtifacts,
  };
}

export function comparePerformanceMeasurements(current, baseline, suite) {
  assert(["throughput", "preview"].includes(suite));
  const expectedMetrics =
    suite === "preview"
      ? ["fps.median", "present_completion_ms.median"]
      : ["fps.median", "completion_interval_ms.median"];
  const expectedGroups = suite === "preview" ? 3 : 9;
  assert.equal(baseline.length, expectedGroups);
  assert.equal(current.length, expectedGroups);
  const byId = new Map(current.map((item) => [`${item.case_id}/${item.mode}`, item]));
  assert.equal(byId.size, expectedGroups);
  const checks = [];
  for (const previous of baseline) {
    const key = `${previous.case_id}/${previous.mode}`;
    const next = byId.get(key);
    assert(next, `Missing performance group: ${key}`);
    byId.delete(key);
    assert.deepEqual(previous.tracked_metrics, expectedMetrics);
    assert.deepEqual(next.tracked_metrics, expectedMetrics, "Tracked performance metrics changed");
    for (const field of ["frames_per_run", "frame_range", "size", "frame_rate"])
      assert.deepEqual(next[field], previous[field]);
    for (const metric of expectedMetrics) {
      const [group, name] = metric.split(".");
      const before = previous[group]?.[name];
      const after = next[group]?.[name];
      assert(
        Number.isFinite(before) && before > 0 && Number.isFinite(after) && after > 0,
        "Missing or invalid tracked median",
      );
      const lowerIsBetter = metric !== "fps.median";
      const limit = before * (lowerIsBetter ? 1.05 : 0.95);
      checks.push({
        group: key,
        metric,
        baseline: before,
        current: after,
        direction: lowerIsBetter ? "lower-is-better" : "higher-is-better",
        regression_percent: (lowerIsBetter ? after / before - 1 : 1 - after / before) * 100,
        limit_percent: 5,
        passed: lowerIsBetter ? after <= limit : after >= limit,
      });
    }
  }
  return { status: checks.every((check) => check.passed) ? "passed" : "failed", checks };
}
