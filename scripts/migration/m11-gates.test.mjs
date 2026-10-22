import assert from "node:assert/strict";
import test from "node:test";
import { assertM11Tasks, bindM11Gates } from "./m11-gates.mjs";
import { staticCommands } from "./static-checks.mjs";

function fixture() {
  const source = { source_sha256: "a".repeat(64), execution_sha256: "b".repeat(64) };
  const passed = { status: "passed", exit_code: 0, signal: null };
  const report = {
    milestone: "M11",
    mode: "full",
    run_id: "2026-10-23T00-00-00-000Z-abcdef01",
    source,
    required_gates: ["G0", "G3", "G4", "G6"],
    gates: [],
  };
  const part = () => ({ status: "passed", source, source_after: source, source_unchanged: true });
  report.gates.push({
    id: "G0",
    status: "passed",
    steps: staticCommands().map((c) => ({ id: c.id, ...passed })),
    hook: { ...passed },
  });
  report.gates.push({ id: "G3", ...part(), corpus: part() });
  report.gates.push({ id: "G4", ...part() });
  report.gates.push({
    id: "G6",
    ...part(),
    interactions: part(),
    plugins: part(),
    recovery: part(),
  });
  const documents = new Map(),
    base = `artifacts/migration/${report.run_id}`;
  for (const gate of report.gates) {
    documents.set(
      `${base}/${gate.id === "G0" ? "static-results.json" : `${gate.id}/report.json`}`,
      gate.id === "G0" ? { quick: false, steps: gate.steps } : gate,
    );
    for (const key of ["corpus", "interactions", "plugins", "recovery"])
      if (gate[key]) documents.set(`${base}/${gate.id}/${key}/report.json`, gate[key]);
  }
  const saved = new Map([...documents].map(([path, value]) => [path, structuredClone(value)]));
  const reader = {
    async json(path) {
      assert(saved.has(path), path);
      return saved.get(path);
    },
    async bytes() {
      return { sha256: "c".repeat(64) };
    },
  };
  return { report, reader, saved, base };
}

test("M11 binds all four current full gates and nested editor/corpus reports", async () => {
  const { report, reader } = fixture();
  const result = await bindM11Gates(reader, report);
  assert.deepEqual(Object.keys(result.pins), ["G0", "G3", "G4", "G6"]);
});

test("M11 rejects partial, stale, duplicated and substituted gate evidence", async () => {
  for (const mutate of [
    (f) => {
      f.report.mode = "quick";
    },
    (f) => {
      f.report.gates.pop();
    },
    (f) => {
      f.report.gates[3] = f.report.gates[2];
    },
    (f) => {
      f.report.gates[2].status = "incomplete";
    },
    (f) => {
      f.saved.get(`${f.base}/G4/report.json`).source.source_sha256 = "d".repeat(64);
    },
    (f) => {
      f.saved.get(`${f.base}/G6/plugins/report.json`).status = "failed";
    },
    (f) => {
      f.report.gates[0].steps[0].status = "skipped";
    },
    (f) => {
      f.saved.get(`${f.base}/static-results.json`).quick = true;
    },
  ]) {
    const f = fixture();
    mutate(f);
    await assert.rejects(bindM11Gates(f.reader, f.report));
  }
});

test("M11 task coverage cannot omit earlier milestones or leave implementation pending", () => {
  const ledger = {
    status: "running",
    milestones: Array.from({ length: 12 }, (_, i) => ({
      id: `M${i}`,
      status: i === 11 ? "in_progress" : "done",
    })),
  };
  ledger.milestones[11].tasks = Array.from({ length: 8 }, (_, i) => ({
    id: `M11-T${i + 1}`,
    status: i < 6 ? "done" : "in_progress",
  }));
  assertM11Tasks(ledger);
  ledger.milestones[11].tasks[5].status = "pending";
  assert.throws(() => assertM11Tasks(ledger));
  ledger.milestones[11].tasks[5].status = "done";
  ledger.milestones[10].status = "in_progress";
  assert.throws(() => assertM11Tasks(ledger));
});
