import assert from "node:assert/strict";
import { prepareWorkloads } from "../performance/workloads.mjs";
import { nativeExportWorkloads } from "./native-export-series.mjs";
import { pairedObservationSchedule } from "./native-paired-measurements.mjs";
import { summarizeProjectPairs } from "./project-paired-measurements.mjs";

/** Recompute the complete paired export decision from authenticated raw observation protocols. */
export async function auditProductionExportPerformance(reader, root, gate, env) {
  assert.equal(gate.kind, "paired-authored-project-exports");
  assert.equal(gate.status, "passed");
  assert.equal(gate.smoke, false);
  assert.equal(gate.full_coverage, true);
  assert.equal(gate.execution_complete, true);
  assert.equal(gate.higher_native_median_fps, true);
  assert.deepEqual(
    gate.workloads.map((w) => w.id),
    nativeExportWorkloads,
  );
  assert.deepEqual(
    gate.observations.map(({ run, renderer }) => ({ run, renderer })),
    pairedObservationSchedule(false),
  );
  const all = await prepareWorkloads(root, env),
    workloads = nativeExportWorkloads.map((id) => all.find((w) => w.case.id === id));
  assert(workloads.every((w) => w && !w.unavailable));
  assert.deepEqual(
    workloads.map(({ caseHash, inputs }) => ({ caseHash, inputs })),
    gate.inputs,
  );
  const observations = [];
  for (const entry of gate.observations) {
    assert.equal(entry.status, "passed");
    const measured = await reader.json(entry.evidence.path, entry.evidence.sha256);
    assert.equal(measured.source.source_sha256, gate.source.source_sha256);
    if (entry.renderer === "ts") {
      assert.deepEqual(measured.retained_runtime, gate.retained_runtime);
      observations.push({
        report: measured,
        raw: await reader.json(measured.raw.path, measured.raw.sha256),
      });
    } else {
      assert.deepEqual(measured.binaries, gate.native_binaries);
      for (const item of measured.cases) {
        const request = await reader.json(item.request.path, item.request.sha256);
        assert.equal(request.rasterProvider.cacheBytes, 67108864);
        const log = (await reader.bytes(item.step.log)).bytes.toString("utf8");
        assert.deepEqual(
          log
            .split(/\r?\n/)
            .filter((line) => line.startsWith("{"))
            .map(JSON.parse),
          item.rows,
        );
      }
      observations.push({ report: measured });
    }
  }
  const compared = summarizeProjectPairs(observations, workloads, false);
  assert.deepEqual(compared, gate.workloads);
  assert(compared.every((w) => w.higher_native_median_fps));
  return { status: "passed", workloads: compared, paired_runs: 4 };
}
