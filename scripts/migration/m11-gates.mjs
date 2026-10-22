import assert from "node:assert/strict";
import { validSha } from "./m0-evidence.mjs";
import { staticCommands } from "./static-checks.mjs";

export function assertM11Tasks(ledger) {
  assert.equal(ledger.status, "running");
  for (let index = 0; index < 11; index++)
    assert.equal(ledger.milestones.find((m) => m.id === `M${index}`)?.status, "done");
  const milestone = ledger.milestones.find((m) => m.id === "M11");
  assert(["in_progress", "done"].includes(milestone?.status));
  assert.deepEqual(
    milestone.tasks.map((t) => t.id),
    Array.from({ length: 8 }, (_, i) => `M11-T${i + 1}`),
  );
  for (const task of milestone.tasks.slice(0, 6)) assert.equal(task.status, "done", task.id);
  // This invocation supplies final acceptance for performance and the exit audit together.
  for (const task of milestone.tasks.slice(6))
    assert(["in_progress", "done"].includes(task.status), task.id);
}

/** Bind current in-memory gates to their exact on-disk invocation before accepting any rollup. */
export async function bindM11Gates(reader, report) {
  assert.equal(report.milestone, "M11");
  assert.equal(report.mode, "full");
  assert(/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[a-f0-9]{8}$/.test(report.run_id));
  const required = ["G0", "G3", "G4", "G6"];
  assert.deepEqual(report.required_gates.toSorted(), required);
  assert.deepEqual(report.gates.map((g) => g.id).toSorted(), required);
  validSha(report.source.source_sha256);
  validSha(report.source.execution_sha256);
  const base = `artifacts/migration/${report.run_id}`,
    pins = {};
  const gates = Object.fromEntries(report.gates.map((g) => [g.id, g]));
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
        gate.steps.map((s) => s.id).sort(),
        staticCommands()
          .map((s) => s.id)
          .sort(),
      );
      for (const step of [...gate.steps, gate.hook]) {
        assert.equal(step.status, "passed");
        assert.equal(step.exit_code, 0);
        assert(!step.error && !step.signal);
      }
    } else {
      assert.deepEqual(saved, gate, `${id} differs from this invocation`);
      assert.equal(gate.source_unchanged, true);
      for (const source of [gate.source, gate.source_after])
        for (const key of ["source_sha256", "execution_sha256"])
          assert.equal(source?.[key], report.source[key], `${id} source differs`);
    }
  }
  for (const [id, key] of [
    ["G3", "corpus"],
    ["G6", "interactions"],
    ["G6", "plugins"],
    ["G6", "recovery"],
  ]) {
    const part = gates[id][key];
    assert.equal(part?.status, "passed", key);
    assert(!part.error);
    const path = `${base}/${id}/${key}/report.json`;
    assert.deepEqual(await reader.json(path), part, `${key} differs from this invocation`);
    for (const source of [part.source, part.source_after])
      for (const field of ["source_sha256", "execution_sha256"])
        assert.equal(source?.[field], report.source[field], `${key} source differs`);
  }
  return { gates, pins, base };
}
