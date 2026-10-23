import assert from "node:assert/strict";
import test from "node:test";
import { assertM12Tasks, bindM12Gates } from "./m12-gates.mjs";
import { staticCommands } from "./static-checks.mjs";

function fixture() {
  const source = { source_sha256: "a".repeat(64), execution_sha256: "b".repeat(64) };
  const base = "artifacts/migration/2026-10-23T00-00-00-000Z-abcdef01";
  const pin = (name) => ({ path: `${base}/${name}/report.json`, sha256: "c".repeat(64) });
  const part = (extra = {}) => ({
    status: "passed",
    source,
    source_after: source,
    source_unchanged: true,
    ...extra,
  });
  const passed = { status: "passed", exit_code: 0, signal: null };
  const gates = {
    G0: {
      status: "passed",
      steps: staticCommands().map((s) => ({ id: s.id, ...passed })),
      hook: passed,
    },
    G1: part(),
    G2: part({ kind: "native-project-corpus", full_coverage: true }),
    G3: part({
      kind: "production-project-and-preview-pixels",
      full_coverage: true,
      project_corpus: pin("G2"),
      project: { status: "passed", source_unchanged: true, project_corpus: pin("G2") },
      preview: part({ corpus: part() }),
      evidence: { project: pin("G3/project"), preview: pin("G3/preview") },
    }),
    G4: part({
      kind: "production-export-and-preview-performance",
      full_coverage: true,
      export: part(),
      preview: part(),
      evidence: { export: pin("G4/export"), preview: pin("G4/preview") },
    }),
    G5: part({
      kind: "native-project-export",
      full_coverage: true,
      native_export_acceptance: true,
      lifecycle: part(),
    }),
    G6: part({
      kind: "production-native-application",
      execution_complete: true,
      evidence: { preview: pin("G6/preview") },
      preview: part({
        production_defaults: true,
        performance_evidence: pin("G4/preview"),
        interactions: part(),
        plugins: part(),
        recovery: part(),
      }),
    }),
  };
  const report = {
    milestone: "M12",
    mode: "full",
    run_id: base.split("/").at(-1),
    source,
    required_gates: Object.keys(gates),
    gates: Object.entries(gates).map(([id, gate]) => ({ id, ...gate })),
  };
  const documents = new Map();
  function save(name, value) {
    documents.set(pin(name).path, structuredClone(value));
    for (const child of [
      "project",
      "preview",
      "export",
      "corpus",
      "lifecycle",
      "interactions",
      "plugins",
      "recovery",
    ])
      if (value[child]) save(`${name}/${child}`, value[child]);
  }
  for (const gate of report.gates.slice(1)) save(gate.id, gate);
  documents.set(
    `${base}/static-results.json`,
    structuredClone({ quick: false, steps: gates.G0.steps }),
  );
  const reader = {
    async json(path) {
      assert(documents.has(path), path);
      return documents.get(path);
    },
    async bytes() {
      return { sha256: "c".repeat(64) };
    },
  };
  return { report, reader, documents, base };
}

test("M12 binds every full gate, complete child report and current independent latency input", async () => {
  const f = fixture(),
    result = await bindM12Gates(f.reader, f.report);
  assert.equal(Object.keys(result.pins).length, 17);
  assert(result.pins["G6/preview/recovery"]);
});

test("M12 rejects stale, partial, substituted and cross-invocation gate evidence", async () => {
  const mutations = [
    (f) => {
      f.report.mode = "quick";
    },
    (f) => {
      f.report.required_gates.pop();
    },
    (f) => {
      f.report.gates[6] = f.report.gates[4];
    },
    (f) => {
      f.report.gates[4].status = "incomplete";
    },
    (f) => {
      f.report.source = { ...f.report.source, execution_sha256: "d".repeat(64) };
    },
    (f) => {
      f.documents.get(`${f.base}/G3/preview/corpus/report.json`).status = "failed";
    },
    (f) => {
      f.documents.delete(`${f.base}/G5/lifecycle/report.json`);
    },
    (f) => {
      f.documents.get(`${f.base}/static-results.json`).quick = true;
    },
    (f) => {
      f.report.gates[0].hook.exit_code = 1;
    },
    (f) => {
      f.report.gates[0].steps.pop();
    },
    (f) => {
      f.report.gates[6].preview.performance_evidence.path = "artifacts/old/G4/report.json";
      f.documents.get(`${f.base}/G6/report.json`).preview = structuredClone(
        f.report.gates[6].preview,
      );
      f.documents.set(
        `${f.base}/G6/preview/report.json`,
        structuredClone(f.report.gates[6].preview),
      );
    },
    (f) => {
      f.report.gates[5].full_coverage = false;
      f.documents.set(`${f.base}/G5/report.json`, structuredClone(f.report.gates[5]));
    },
    (f) => {
      f.report.gates[3].project_corpus.sha256 = "d".repeat(64);
      f.documents.set(`${f.base}/G3/report.json`, structuredClone(f.report.gates[3]));
    },
  ];
  for (const mutate of mutations) {
    const f = fixture();
    mutate(f);
    await assert.rejects(bindM12Gates(f.reader, f.report));
  }
});

test("M12 final acceptance requires completed implementation and delivery, with all previous milestones done", () => {
  const ledger = {
    status: "running",
    milestones: Array.from({ length: 13 }, (_, i) => ({
      id: `M${i}`,
      status: i === 12 ? "in_progress" : "done",
      tasks: Array.from({ length: 9 }, (_, j) => ({
        id: `M${i}-T${j + 1}`,
        status: j === 8 ? "in_progress" : "done",
      })),
    })),
  };
  assertM12Tasks(ledger);
  for (const mutate of [
    (l) => {
      l.status = "blocked";
    },
    (l) => {
      l.milestones[11].status = "in_progress";
    },
    (l) => {
      l.milestones[12].tasks[7].status = "pending";
    },
    (l) => {
      l.milestones[12].tasks[8].status = "pending";
    },
    (l) => {
      l.milestones.push(l.milestones[0]);
    },
  ]) {
    const changed = structuredClone(ledger);
    mutate(changed);
    assert.throws(() => assertM12Tasks(changed));
  }
});
