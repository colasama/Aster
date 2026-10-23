import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { loadRetainedPerformanceRuntime } from "../performance/retained-runtime.mjs";
import { prepareWorkloads } from "../performance/workloads.mjs";
import { runExportObservation } from "./native-export-observation.mjs";
import { nativeExportWorkloads } from "./native-export-series.mjs";
import { pairedObservationSchedule } from "./native-paired-measurements.mjs";
import { runNativeProjectExportObservation } from "./native-project-export-observation.mjs";
import { prepareNativeProjectRuntime } from "./native-project-runtime.mjs";
import { runStep } from "./process.mjs";
import { summarizeProjectPairs } from "./project-paired-measurements.mjs";
import { writeAtomicJson } from "./report.mjs";
import { hashFile, sourceProvenance } from "./source.mjs";

/** Measure current Rust-authored projects against the independently retained TS export program. */
export async function runProjectPerformanceGate(context, execute = runStep, options = {}) {
  const { root, output } = context,
    started = Date.now();
  const selected = options.cases ?? nativeExportWorkloads,
    smoke = Boolean(options.smoke);
  const local = (path) => relative(root, path).replaceAll("\\", "/");
  const report = {
    id: "G4",
    kind: "paired-authored-project-exports",
    status: "failed",
    smoke,
    full_coverage: false,
    native_export_acceptance: false,
    observations: [],
    workloads: [],
    method:
      "Four balanced retained TS/Rust-project pairs, ten completed same-session warm-up frames per run, monotonic complete-export intervals and R-7 distributions. Smoke uses two ten-frame pairs and cannot establish G4. G5 independently accepts quality at the same 20 Mbps.",
  };
  await mkdir(output, { recursive: true });
  try {
    assert(selected.length && new Set(selected).size === selected.length);
    assert(selected.every((id) => nativeExportWorkloads.includes(id)));
    report.source = await sourceProvenance(root);
    if (context.source) assert.equal(report.source.source_sha256, context.source.source_sha256);
    const all = await prepareWorkloads(root, context.env),
      workloads = selected.map((id) => all.find((item) => item.case.id === id));
    assert(workloads.every((item) => item && !item.unavailable));
    report.inputs = workloads.map(({ caseHash, inputs }) => ({ caseHash, inputs }));
    const retained = await loadRetainedPerformanceRuntime(root);
    report.retained_runtime = retained.provenance;
    const native = await prepareNativeProjectRuntime(
      { ...context, output: join(output, "native-runtime") },
      execute,
    );
    assert.equal(native.source.source_sha256, report.source.source_sha256);
    report.build = native.build;
    report.native_execution_artifacts = native.execution.snapshot;
    report.native_binaries = native.binaries;
    const observations = [],
      pins = [];
    for (const { run, renderer } of pairedObservationSchedule(smoke)) {
      const destination = join(output, `pair-${run}-${renderer}`),
        observedContext = { ...context, output: destination };
      // Keep each GPU arm serial and close its processes before starting the next.
      const measured =
        renderer === "ts"
          ? await runExportObservation(observedContext, { cases: selected, smoke, run, renderer })
          : await runNativeProjectExportObservation(observedContext, native, {
              cases: selected,
              smoke,
              run,
            });
      const path = join(destination, "report.json"),
        evidence = { path: local(path), sha256: await hashFile(path) };
      report.observations.push({ run, renderer, evidence, status: measured.status });
      assert.deepEqual(JSON.parse(await readFile(path, "utf8")), measured);
      assert.equal(measured.status, "passed", measured.error);
      assert.equal(measured.source.source_sha256, report.source.source_sha256);
      pins.push(evidence, ...Object.values(measured.binaries));
      if (renderer === "ts") {
        assert.deepEqual(measured.retained_runtime, retained.provenance);
        assert.equal(await hashFile(join(root, measured.raw.path)), measured.raw.sha256);
        const raw = JSON.parse(await readFile(join(root, measured.raw.path), "utf8"));
        observations.push({ report: measured, raw });
        pins.push(measured.raw, ...measured.outputs);
        context.print?.(
          `pair ${run} TS: ${raw.cases.map((c) => `${c.result.caseId} ${c.result.framesPerSecond.toFixed(3)} FPS`).join(", ")}`,
        );
      } else {
        observations.push({ report: measured });
        for (const entry of measured.cases) {
          assert.equal(entry.step.status, "passed");
          assert.equal(entry.step.command[0], native.binary);
          const log = join(root, entry.step.log),
            rows = (await readFile(log, "utf8"))
              .split(/\r?\n/)
              .filter((line) => line.startsWith("{"))
              .map(JSON.parse);
          assert.deepEqual(rows, entry.rows);
          pins.push(entry.request, entry.output, {
            path: entry.step.log,
            sha256: await hashFile(log),
          });
        }
        context.print?.(
          `pair ${run} Rust project: ${measured.cases.map((c) => `${c.id} ${c.measurement.fps.toFixed(3)} FPS`).join(", ")}`,
        );
      }
    }
    report.workloads = summarizeProjectPairs(observations, workloads, smoke);
    report.hardware = observations[0].report.hardware;
    report.hardware_after = observations.at(-1).report.hardware_after;
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
    for (const pin of pins)
      assert.equal(await hashFile(join(root, pin.path)), pin.sha256, "Paired evidence changed");
    report.source_after = await sourceProvenance(root);
    report.source_unchanged = report.source.source_sha256 === report.source_after.source_sha256;
    assert(report.source_unchanged);
    report.evidence = pins;
    report.execution_complete = true;
    report.full_coverage = !smoke && nativeExportWorkloads.every((id) => selected.includes(id));
    report.higher_native_median_fps = report.workloads.every(
      (item) => item.higher_native_median_fps,
    );
    report.status = report.full_coverage
      ? report.higher_native_median_fps
        ? "passed"
        : "failed"
      : "incomplete";
    if (report.full_coverage && !report.higher_native_median_fps)
      report.error =
        "Native project export median FPS does not exceed retained TS on every workload";
  } catch (error) {
    report.error = error.stack ?? String(error);
  }
  report.duration_ms = Date.now() - started;
  await writeAtomicJson(join(output, "report.json"), report);
  return report;
}
