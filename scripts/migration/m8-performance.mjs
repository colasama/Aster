import assert from "node:assert/strict";
import { auditExecutionArtifacts } from "../performance/execution-artifacts.mjs";
import { loadRetainedPerformanceRuntime } from "../performance/retained-runtime.mjs";
import { prepareWorkloads } from "../performance/workloads.mjs";
import { nativeExportWorkloads } from "./native-export-series.mjs";
import {
  pairedObservationSchedule,
  summarizePairedObservations,
} from "./native-paired-measurements.mjs";

/** Authenticate every raw paired observation, then recompute all five workload distributions. */
export async function auditM8Performance(reader, gate, report, env) {
  assert.equal(gate.status, "passed");
  assert.equal(gate.smoke, false);
  assert.equal(gate.full_coverage, true);
  assert.equal(gate.execution_complete, true);
  assert.equal(gate.source_unchanged, true);
  for (const source of [gate.source, gate.source_after])
    assert.equal(source.source_sha256, report.source.source_sha256);
  assert.deepEqual(
    gate.workloads.map((w) => w.id),
    nativeExportWorkloads,
  );
  const all = await prepareWorkloads(reader.root, env);
  const workloads = nativeExportWorkloads.map((id) => all.find((w) => w.case.id === id));
  assert(workloads.every((w) => w && !w.unavailable));
  assert.deepEqual(
    gate.inputs,
    workloads.map(({ caseHash, inputs }) => ({ caseHash, inputs })),
  );
  const retained = await loadRetainedPerformanceRuntime(reader.root);
  assert.deepEqual(gate.retained_runtime, retained.provenance);
  await auditExecutionArtifacts(reader.root, gate.native_execution_artifacts);
  const schedule = pairedObservationSchedule();
  assert.equal(gate.observations.length, schedule.length);
  const observations = [];
  for (const [index, item] of gate.observations.entries()) {
    assert.equal(item.status, "passed");
    assert.deepEqual({ run: item.run, renderer: item.renderer }, schedule[index]);
    const measured = await reader.json(item.evidence.path, item.evidence.sha256);
    assert.equal(measured.source.source_sha256, report.source.source_sha256);
    const raw = await reader.json(measured.raw.path, measured.raw.sha256);
    for (const file of [...measured.outputs, ...Object.values(measured.binaries)])
      await reader.bytes(file.path, file.sha256);
    if (item.renderer === "rust")
      assert.deepEqual(measured.execution_artifacts, gate.native_execution_artifacts);
    else assert.deepEqual(measured.retained_runtime, retained.provenance);
    observations.push({ report: measured, raw });
  }
  const recomputed = summarizePairedObservations(observations, workloads);
  assert.deepEqual(gate.workloads, recomputed);
  assert.equal(gate.higher_native_median_fps, true);
  assert(recomputed.every((w) => w.higher_native_median_fps));
  await retained.assertStable();
  return { status: "passed", workloads: recomputed, observations: schedule.length };
}
