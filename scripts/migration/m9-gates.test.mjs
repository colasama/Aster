import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { assertM9ExitTasks, bindM9GateReports } from "./m9-gates.mjs";
import { staticCommands } from "./static-checks.mjs";

function fixture() {
  const source = { source_sha256: "a".repeat(64), execution_sha256: "b".repeat(64) };
  const run_id = "2026-10-20T07-49-52-871Z-5959cc44",
    base = `artifacts/migration/${run_id}`;
  const steps = staticCommands().map(({ id }) => ({ id, status: "passed", exit_code: 0 }));
  const gates = [
    { id: "G0", status: "passed", steps, hook: { status: "passed", exit_code: 0 } },
    ...["G1", "G2", "G3", "G5"].map((id) => ({
      id,
      status: "passed",
      source_unchanged: true,
      ...(id === "G3" ? {} : { source, source_after: source }),
      full_coverage: true,
    })),
  ];
  const report = {
    milestone: "M9",
    mode: "full",
    run_id,
    required_gates: gates.map((g) => g.id),
    source,
    gates,
    required_gates_passed: false,
    milestone_exit_satisfied: false,
  };
  const g = (id) => gates.find((x) => x.id === id);
  g("G2").kind = "native-project-corpus";
  g("G3").scope = "full";
  g("G3").inputs_unchanged = true;
  g("G5").kind = "native-project-export";
  g("G5").native_export_acceptance = true;
  g("G5").lifecycle = { status: "passed", source_unchanged: true, source, source_after: source };
  const files = new Map();
  const set = (path, obj) => files.set(path, structuredClone(obj));
  const bytes = async (path) => {
    assert(files.has(path), path);
    const bytes = Buffer.from(JSON.stringify(files.get(path)));
    return { bytes, sha256: createHash("sha256").update(bytes).digest("hex") };
  };
  const reader = { bytes, json: async (path) => JSON.parse((await bytes(path)).bytes) };
  const sync = async () => {
    set(`${base}/static-results.json`, { quick: false, steps: g("G0").steps });
    for (const id of ["G1", "G2", "G3", "G5"]) set(`${base}/${id}/report.json`, g(id));
    g("G3").project_corpus = {
      path: `${base}/G2/report.json`,
      sha256: (await bytes(`${base}/G2/report.json`)).sha256,
    };
    set(`${base}/G3/report.json`, g("G3"));
    set(`${base}/G5/lifecycle/report.json`, g("G5").lifecycle);
  };
  const ledger = {
    status: "running",
    milestones: [
      ...Array.from({ length: 9 }, (_, i) => ({ id: `M${i}`, status: "done" })),
      {
        id: "M9",
        status: "in_progress",
        tasks: Array.from({ length: 20 }, (_, i) => ({
          id: `M9-T${i + 1}`,
          status: i === 19 ? "in_progress" : "done",
        })),
      },
    ],
  };
  return { report, reader, files, g, base, sync, ledger };
}
test("exit consumes full current gate results before enclosing exit fields are finalized", async () => {
  const f = fixture();
  await f.sync();
  assertM9ExitTasks(f.ledger);
  const result = await bindM9GateReports(f.reader, f.report);
  assert.equal(Object.keys(result.pins).length, 5);
});
test("exit rejects stale, partial, substituted and contradictory evidence", async () => {
  const attacks = [
    (f) => {
      f.report.mode = "quick";
    },
    (f) => {
      f.report.required_gates.pop();
    },
    (f) => {
      f.report.gates.push(f.report.gates[0]);
    },
    (f) => {
      f.g("G2").status = "failed";
    },
    async (f) => {
      f.g("G2").source = { ...f.report.source, source_sha256: "c".repeat(64) };
      await f.sync();
    },
    async (f) => {
      f.g("G2").kind = "supplied-plan-corpus";
      await f.sync();
    },
    async (f) => {
      f.g("G5").kind = "native-export";
      await f.sync();
    },
    async (f) => {
      f.g("G5").full_coverage = false;
      await f.sync();
    },
    async (f) => {
      f.g("G3").inputs_unchanged = false;
      await f.sync();
    },
    (f) => {
      f.files.get(`${f.base}/G3/report.json`).status = "failed";
    },
    (f) => {
      f.g("G3").project_corpus.sha256 = "d".repeat(64);
      f.files.set(`${f.base}/G3/report.json`, structuredClone(f.g("G3")));
    },
    (f) => {
      f.files.get(`${f.base}/static-results.json`).quick = true;
    },
    (f) => {
      f.g("G0").hook.exit_code = 1;
    },
    (f) => {
      f.files.get(`${f.base}/G5/lifecycle/report.json`).status = "failed";
    },
    async (f) => {
      f.g("G5").lifecycle.source_after = { ...f.report.source, execution_sha256: "e".repeat(64) };
      await f.sync();
    },
  ];
  for (const attack of attacks) {
    const f = fixture();
    await f.sync();
    await attack(f);
    await assert.rejects(() => bindM9GateReports(f.reader, f.report));
  }
});
test("exit cannot skip earlier tasks or accept T19 completion as M9 completion", () => {
  for (const change of [
    (f) => {
      f.ledger.milestones[8].status = "in_progress";
    },
    (f) => {
      f.ledger.milestones[9].tasks[18].status = "in_progress";
    },
    (f) => {
      f.ledger.milestones[9].tasks[19].status = "pending";
    },
    (f) => {
      f.ledger.status = "blocked";
    },
  ]) {
    const f = fixture();
    change(f);
    assert.throws(() => assertM9ExitTasks(f.ledger));
  }
});
