import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { loadRetainedPerformanceRuntime } from "../performance/retained-runtime.mjs";
import { prepareWorkloads } from "../performance/workloads.mjs";
import { runExportObservation } from "./native-export-observation.mjs";
import { nativeExportWorkloads } from "./native-export-series.mjs";
import { prepareNativeObservationRuntime } from "./native-observation-runtime.mjs";
import {
  pairedObservationSchedule,
  summarizePairedObservations,
} from "./native-paired-measurements.mjs";
import { runStep } from "./process.mjs";
import { writeAtomicJson } from "./report.mjs";
import { hashFile, sourceProvenance } from "./source.mjs";

/** Measure independent production programs, with per-run warm-up and balanced ordering. */
export async function runNativePerformanceGate(context, execute = runStep, options = {}) {
  const started = Date.now();
  const { root, output } = context;
  const local = (path) => relative(root, path).replaceAll("\\", "/");
  const selected = options.cases ?? nativeExportWorkloads;
  const smoke = Boolean(options.smoke);
  const report = {
    id: "G4",
    status: "failed",
    observations: [],
    workloads: [],
    native_export_acceptance: false,
    method:
      "Four matched pairs alternating retained TS/Rust first, each with ten completed warm-up frames excluded. Prepared-to-durable-completion timing; R-7 median/p95/p99. Two ten-frame pairs in smoke mode. G5 independently requires matched output quality.",
    smoke,
    full_coverage: false,
  };
  await mkdir(output, { recursive: true });
  try {
    assert(selected.length && new Set(selected).size === selected.length);
    assert(selected.every((id) => nativeExportWorkloads.includes(id)));
    report.source = await sourceProvenance(root);
    if (context.source) assert.equal(report.source.source_sha256, context.source.source_sha256);
    report.full_coverage = !smoke && nativeExportWorkloads.every((id) => selected.includes(id));
    const all = await prepareWorkloads(root, context.env);
    const workloads = selected.map((id) => all.find((item) => item.case.id === id));
    assert(
      workloads.every((item) => item && !item.unavailable),
      "Required export workload unavailable",
    );
    report.inputs = workloads.map(({ caseHash, inputs }) => ({ caseHash, inputs }));
    const retained = await loadRetainedPerformanceRuntime(root);
    report.retained_runtime = retained.provenance;
    const native = await prepareNativeObservationRuntime(
      { ...context, output: join(output, "native-runtime") },
      execute,
    );
    assert.equal(native.source.source_sha256, report.source.source_sha256);
    report.native_execution_artifacts = native.execution.snapshot;
    report.build = native.build;
    const observations = [];
    const files = [];
    for (const { run, renderer } of pairedObservationSchedule(smoke)) {
      const destination = join(output, `pair-${run}-${renderer}`);
      const measured = await runExportObservation(
        { ...context, output: destination },
        { cases: selected, smoke, run, renderer, preparedNative: native },
      );
      const path = join(destination, "report.json");
      const evidence = { path: local(path), sha256: await hashFile(path) };
      report.observations.push({ run, renderer, evidence, status: measured.status });
      assert.equal(measured.status, "passed", measured.error);
      assert.equal(measured.source.source_sha256, report.source.source_sha256);
      if (renderer === "ts") assert.deepEqual(measured.retained_runtime, retained.provenance);
      assert.equal(await hashFile(join(root, measured.raw.path)), measured.raw.sha256);
      const raw = JSON.parse(await readFile(join(root, measured.raw.path), "utf8"));
      observations.push({ report: measured, raw });
      files.push(evidence, measured.raw, ...measured.outputs, ...Object.values(measured.binaries));
      context.print?.(
        `pair ${run} ${renderer}: ${raw.cases.map((entry) => `${entry.caseId} ${entry.result.framesPerSecond.toFixed(3)} FPS`).join(", ")}`,
      );
    }
    report.workloads = summarizePairedObservations(observations, workloads, smoke);
    const after = await prepareWorkloads(root, context.env);
    assert.deepEqual(
      selected.map((id) => {
        const { caseHash, inputs } = after.find((item) => item.case.id === id);
        return { caseHash, inputs };
      }),
      report.inputs,
    );
    await native.assertUnchanged();
    await retained.assertStable();
    for (const entry of files)
      assert.equal(
        await hashFile(join(root, entry.path)),
        entry.sha256,
        "Paired measurement artifact changed",
      );
    report.source_after = await sourceProvenance(root);
    report.source_unchanged = report.source.source_sha256 === report.source_after.source_sha256;
    assert(report.source_unchanged);
    report.execution_complete = true;
    report.higher_native_median_fps = report.workloads.every(
      (item) => item.higher_native_median_fps,
    );
    report.status = report.full_coverage
      ? report.higher_native_median_fps
        ? "passed"
        : "failed"
      : "incomplete";
    report.quality_acceptance =
      "G5 must separately pass at the same 20 Mbps bitrate and workloads; this report cannot accept pixels or complete M8";
    if (report.full_coverage && !report.higher_native_median_fps)
      report.error = "Native median FPS does not exceed retained TS on every required workload";
  } catch (error) {
    report.error = error.stack ?? String(error);
  }
  report.duration_ms = Date.now() - started;
  await writeAtomicJson(join(output, "report.json"), report);
  return report;
}
