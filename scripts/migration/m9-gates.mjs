import assert from "node:assert/strict";
import { validSha } from "./m0-evidence.mjs";
import { staticCommands } from "./static-checks.mjs";

/** Consume the current invocation's gate results, never cached gate-status claims. */
export async function bindM9GateReports(reader, report) {
  assert.equal(report.milestone, "M9");
  assert.equal(report.mode, "full");
  assert(/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[a-f0-9]{8}$/.test(report.run_id));
  const required = ["G0", "G1", "G2", "G3", "G5"];
  assert.deepEqual(report.required_gates.toSorted(), required);
  assert.deepEqual(report.gates.map((gate) => gate.id).toSorted(), required);
  validSha(report.source.source_sha256);
  validSha(report.source.execution_sha256);
  const base = `artifacts/migration/${report.run_id}`;
  const gates = Object.fromEntries(report.gates.map((gate) => [gate.id, gate]));
  const pins = {};
  for (const id of required) {
    const gate = gates[id];
    assert.equal(gate.status, "passed", `Full current ${id} is required`);
    assert(!gate.error);
    const path = `${base}/${id === "G0" ? "static-results.json" : `${id}/report.json`}`;
    const saved = await reader.json(path);
    pins[id] = { path, sha256: (await reader.bytes(path)).sha256 };
    if (id === "G0") {
      assert.equal(saved.quick, false);
      assert.deepEqual(saved.steps, gate.steps);
      assert.deepEqual(
        gate.steps.map((step) => step.id).sort(),
        staticCommands()
          .map((step) => step.id)
          .sort(),
      );
      assert(
        gate.steps.every(
          (step) => step.status === "passed" && step.exit_code === 0 && !step.error && !step.signal,
        ),
      );
      assert.equal(gate.hook.status, "passed");
      assert.equal(gate.hook.exit_code, 0);
      assert(!gate.hook.error && !gate.hook.signal);
    } else {
      assert.deepEqual(saved, gate, `${id} report differs from this invocation's result`);
      assert.equal(gate.source_unchanged, true);
      if (id !== "G3") {
        for (const source of [gate.source, gate.source_after]) {
          assert.equal(source?.source_sha256, report.source.source_sha256);
          assert.equal(source?.execution_sha256, report.source.execution_sha256);
        }
      }
    }
  }
  assert.equal(gates.G2.kind, "native-project-corpus");
  assert.equal(gates.G5.kind, "native-project-export");
  for (const id of ["G2", "G3", "G5"]) assert.equal(gates[id].full_coverage, true);
  assert.equal(gates.G3.scope, "full");
  assert.equal(gates.G3.inputs_unchanged, true);
  assert.deepEqual(gates.G3.project_corpus, pins.G2);
  assert.equal(gates.G5.native_export_acceptance, true);
  const lifecycle = await reader.json(`${base}/G5/lifecycle/report.json`);
  assert.deepEqual(lifecycle, gates.G5.lifecycle);
  assert.equal(lifecycle.status, "passed");
  assert.equal(lifecycle.source_unchanged, true);
  for (const source of [lifecycle.source, lifecycle.source_after]) {
    assert.equal(source?.source_sha256, report.source.source_sha256);
    assert.equal(source?.execution_sha256, report.source.execution_sha256);
  }
  return { gates, pins, base };
}

export function assertM9ExitTasks(ledger) {
  assert.equal(ledger.status, "running");
  assert.equal(new Set(ledger.milestones.map((m) => m.id)).size, ledger.milestones.length);
  for (let index = 0; index < 9; index++)
    assert.equal(ledger.milestones.find((m) => m.id === `M${index}`)?.status, "done");
  const milestone = ledger.milestones.find((m) => m.id === "M9");
  assert(["in_progress", "done"].includes(milestone?.status));
  assert.equal(new Set(milestone.tasks.map((task) => task.id)).size, milestone.tasks.length);
  assert.equal(milestone.tasks.at(-1)?.id, "M9-T20");
  assert(["in_progress", "done"].includes(milestone.tasks.at(-1).status));
  for (const task of milestone.tasks.slice(0, -1)) assert.equal(task.status, "done", task.id);
}
