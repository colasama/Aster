import assert from "node:assert/strict";
import { validSha } from "./m0-evidence.mjs";
import { staticCommands } from "./static-checks.mjs";

/** Exit consumes only the complete gates executed by this invocation. */
export async function bindM10Gates(reader, report) {
  assert.equal(report.milestone, "M10");
  assert.equal(report.mode, "full");
  assert(/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[a-f0-9]{8}$/.test(report.run_id));
  assert.deepEqual(report.required_gates.toSorted(), ["G0", "G3"]);
  assert.deepEqual(report.gates.map((g) => g.id).toSorted(), ["G0", "G3"]);
  validSha(report.source.source_sha256);
  validSha(report.source.execution_sha256);
  const base = `artifacts/migration/${report.run_id}`;
  const gates = Object.fromEntries(report.gates.map((g) => [g.id, g]));
  const pins = {};
  for (const id of ["G0", "G3"]) {
    const gate = gates[id];
    assert.equal(gate.status, "passed", `Full current ${id} is required`);
    assert(!gate.error);
    const path = `${base}/${id === "G0" ? "static-results.json" : "G3/report.json"}`;
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
    } else assert.deepEqual(saved, gate, "G3 differs from this invocation's result");
  }
  const g = gates.G3;
  assert.equal(g.full_coverage, true);
  assert.equal(g.native_gpu_execution, true);
  for (const [key, directory] of [
    ["native_text_layout", "native-text-layout"],
    ["native_glyph_composite", "native-glyph-composite"],
    ["native_text_fonts", "native-text-fonts"],
    ["native_text_capabilities", "native-text-capabilities"],
    ["native_text_embedded", "native-text-embedded"],
    ["native_text_blur", "native-text-blur"],
  ]) {
    const part = g[key];
    assert.equal(part?.status, "passed", key);
    assert(!part.error);
    assert.deepEqual(await reader.json(`${base}/G3/${directory}/report.json`), part);
    if (key !== "native_glyph_composite") {
      for (const source of [part.source, part.source_after]) {
        assert.equal(source?.source_sha256, report.source.source_sha256, key);
        assert.equal(source?.execution_sha256, report.source.execution_sha256, key);
      }
    }
  }
  return { gate: g, pins };
}

export function assertM10Tasks(ledger) {
  assert.equal(ledger.status, "running");
  for (let i = 0; i < 10; i++)
    assert.equal(ledger.milestones.find((m) => m.id === `M${i}`)?.status, "done");
  const m = ledger.milestones.find((m) => m.id === "M10");
  assert(["in_progress", "done"].includes(m?.status));
  assert.deepEqual(
    m.tasks.map((t) => t.id),
    Array.from({ length: 8 }, (_, i) => `M10-T${i + 1}`),
  );
  for (const task of m.tasks.slice(0, -1)) assert.equal(task.status, "done", task.id);
  assert(["in_progress", "done"].includes(m.tasks.at(-1).status));
  return m.tasks.at(-1);
}
