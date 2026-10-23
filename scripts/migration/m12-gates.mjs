import assert from "node:assert/strict";
import { validSha } from "./m0-evidence.mjs";
import { staticCommands } from "./static-checks.mjs";

export function assertM12Tasks(ledger) {
  assert.equal(ledger.status, "running");
  assert.equal(new Set(ledger.milestones.map((m) => m.id)).size, ledger.milestones.length);
  for (let index = 0; index < 12; index++)
    assert.equal(ledger.milestones.find((m) => m.id === `M${index}`)?.status, "done");
  const milestone = ledger.milestones.find((m) => m.id === "M12");
  assert(["in_progress", "done"].includes(milestone?.status));
  assert.deepEqual(
    milestone.tasks.map((t) => t.id),
    Array.from({ length: 9 }, (_, i) => `M12-T${i + 1}`),
  );
  for (const task of milestone.tasks.slice(0, 8)) assert.equal(task.status, "done", task.id);
  assert(["in_progress", "done"].includes(milestone.tasks[8].status));
  return milestone;
}

/** Bind all seven gates and their independently complete children to one current full invocation. */
export async function bindM12Gates(reader, report) {
  assert.equal(report.milestone, "M12");
  assert.equal(report.mode, "full");
  assert(/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[a-f0-9]{8}$/.test(report.run_id));
  const required = ["G0", "G1", "G2", "G3", "G4", "G5", "G6"];
  assert.deepEqual(report.required_gates.toSorted(), required);
  assert.deepEqual(report.gates.map((g) => g.id).toSorted(), required);
  for (const key of ["source_sha256", "execution_sha256"]) validSha(report.source[key]);
  const base = `artifacts/migration/${report.run_id}`,
    gates = Object.fromEntries(report.gates.map((g) => [g.id, g])),
    pins = {};
  const bind = async (name, part, sourceRequired = true) => {
    assert.equal(part?.status, "passed", name);
    assert(!part.error, name);
    assert.equal(part.source_unchanged, true, name);
    const path = `${base}/${name}/report.json`;
    assert.deepEqual(await reader.json(path), part, `${name} differs from this invocation`);
    pins[name] = { path, sha256: (await reader.bytes(path)).sha256 };
    if (sourceRequired)
      for (const source of [part.source, part.source_after])
        for (const key of ["source_sha256", "execution_sha256"])
          assert.equal(source?.[key], report.source[key], `${name} source differs`);
  };
  const path = `${base}/static-results.json`,
    saved = await reader.json(path),
    g0 = gates.G0;
  assert.equal(g0.status, "passed");
  assert(!g0.error);
  assert.equal(saved.quick, false);
  assert.deepEqual(saved.steps, g0.steps);
  assert.deepEqual(
    g0.steps.map((s) => s.id).sort(),
    staticCommands()
      .map((s) => s.id)
      .sort(),
  );
  for (const step of [...g0.steps, g0.hook]) {
    assert.equal(step.status, "passed");
    assert.equal(step.exit_code, 0);
    assert(!step.error && !step.signal);
  }
  pins.G0 = { path, sha256: (await reader.bytes(path)).sha256 };
  for (const id of required.slice(1)) await bind(id, gates[id]);
  for (const [name, part] of [
    ["G3/preview", gates.G3.preview],
    ["G3/preview/corpus", gates.G3.preview?.corpus],
    ["G4/export", gates.G4.export],
    ["G4/preview", gates.G4.preview],
    ["G5/lifecycle", gates.G5.lifecycle],
    ["G6/preview", gates.G6.preview],
    ...["interactions", "plugins", "recovery"].map((name) => [
      `G6/preview/${name}`,
      gates.G6.preview?.[name],
    ]),
  ])
    await bind(name, part);
  // Project pixels derive their current-source identity from the authenticated G2 candidates.
  await bind("G3/project", gates.G3.project, false);
  assert.equal(gates.G2.kind, "native-project-corpus");
  assert.equal(gates.G5.kind, "native-project-export");
  assert.equal(gates.G3.kind, "production-project-and-preview-pixels");
  assert.equal(gates.G4.kind, "production-export-and-preview-performance");
  assert.equal(gates.G6.kind, "production-native-application");
  for (const id of ["G2", "G3", "G4", "G5"]) assert.equal(gates[id].full_coverage, true);
  assert.equal(gates.G5.native_export_acceptance, true);
  assert.equal(gates.G6.execution_complete, true);
  assert.equal(gates.G6.preview.production_defaults, true);
  assert.deepEqual(gates.G3.project_corpus, pins.G2);
  assert.deepEqual(gates.G3.project.project_corpus, pins.G2);
  for (const [id, names] of [
    ["G3", ["project", "preview"]],
    ["G4", ["export", "preview"]],
    ["G6", ["preview"]],
  ])
    for (const name of names) assert.deepEqual(gates[id].evidence[name], pins[`${id}/${name}`]);
  assert.deepEqual(gates.G6.preview.performance_evidence, pins["G4/preview"]);
  return { gates, pins, base };
}
