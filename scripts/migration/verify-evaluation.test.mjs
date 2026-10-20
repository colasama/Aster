import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { writeAtomicJson } from "./report.mjs";
import { verifyMigration } from "./verify.mjs";
import { fakeHook, fixture, provenance } from "./verify-fixtures.mjs";

test("M9 exit runs only with all current full gates and propagates audit failure", async (t) => {
  for (const mode of ["passed", "failed-exit", "failed-gate", "quick"]) {
    const context = await fixture(t);
    await writeAtomicJson(context.ledger, {
      status: "running",
      milestones: [
        {
          id: "M9",
          status: "in_progress",
          gates: ["G0", "G1", "G2", "G3", "G5"],
          tasks: [{ id: "M9-T20", status: "in_progress" }],
        },
      ],
    });
    let audited = 0;
    const result = await verifyMigration(
      { ...context, quick: mode === "quick" },
      {
        provenance,
        execute: fakeHook,
        runNativeProjectGate: async () => ({ id: "G1", status: "passed" }),
        runNativeProjectCorpusGate: async (ctx) => {
          const gate = { id: "G2", status: "passed", kind: "native-project-corpus" };
          await writeAtomicJson(join(ctx.output, "report.json"), gate);
          return gate;
        },
        runNativeProjectPixelGate: async () => ({
          id: "G3",
          status: mode === "failed-gate" ? "failed" : "passed",
        }),
        runNativeProjectExportGate: async () => ({ id: "G5", status: "passed" }),
        auditM9Exit: async (_root, report) => {
          audited++;
          assert.equal(report.mode, "full");
          assert(report.gates.every((gate) => gate.status === "passed"));
          if (mode === "failed-exit") throw new Error("Native project provenance differs");
          return { status: "passed" };
        },
      },
    );
    assert.equal(audited, ["passed", "failed-exit"].includes(mode) ? 1 : 0);
    assert.equal(result.report.milestone_exit_satisfied, mode === "passed");
    if (["failed-exit", "failed-gate"].includes(mode)) assert.equal(result.exitCode, 1);
  }
});

test("M9 project round trips cannot promote retained TS candidates to native evaluation acceptance", async (t) => {
  const context = await fixture(t);
  await writeAtomicJson(context.ledger, {
    status: "running",
    milestones: [
      {
        id: "M9",
        status: "in_progress",
        gates: ["G0", "G1", "G2", "G3", "G5"],
        tasks: [{ id: "M9-T1", status: "in_progress" }],
      },
    ],
  });
  let roundtrips = 0;
  const result = await verifyMigration(context, {
    provenance,
    execute: fakeHook,
    runNativeProjectGate: async () => {
      roundtrips++;
      return { id: "G1", status: "passed" };
    },
    runNativeProjectCorpusGate: async () => ({ id: "G2", status: "failed" }),
    runNativeProjectPixelGate: async () => {
      throw new Error("Failed project plan parity cannot supply native pixel candidates");
    },
    runNativeProjectExportGate: async () => {
      throw new Error("Failed project plan parity cannot trigger full export acceptance");
    },
    runPixelGate: async () => {
      throw new Error("Legacy candidates must not run in native evaluation acceptance");
    },
  });
  assert.equal(roundtrips, 1);
  assert.equal(result.report.gates.find((gate) => gate.id === "G1").status, "passed");
  for (const id of ["G2", "G3", "G5"])
    assert.equal(result.report.gates.find((gate) => gate.id === id).status, "failed");
  assert.equal(result.report.required_gates_passed, false);
  assert.equal(result.report.milestone_exit_satisfied, false);
});

test("M9 wires pixels and exports to current project evidence instead of supplied candidate flags", async (t) => {
  const context = await fixture(t);
  await writeAtomicJson(context.ledger, {
    status: "running",
    milestones: [
      {
        id: "M9",
        status: "in_progress",
        gates: ["G0", "G1", "G2", "G3", "G5"],
        tasks: [{ id: "M9-T19", status: "in_progress" }],
      },
    ],
  });
  const visited = [];
  const result = await verifyMigration(
    {
      ...context,
      candidates: "retained-ts.json",
      projectCorpusResume: "native-project-corpus.json",
      exportResume: "native-project-exports.json",
    },
    {
      provenance,
      execute: fakeHook,
      runNativeProjectGate: async () => ({ id: "G1", status: "passed" }),
      runNativeProjectCorpusGate: async (ctx) => {
        visited.push("G2");
        assert.equal(ctx.projectCorpusResume, "native-project-corpus.json");
        const gate = { id: "G2", status: "passed", kind: "native-project-corpus" };
        await writeAtomicJson(join(ctx.output, "report.json"), gate);
        return gate;
      },
      runNativeProjectPixelGate: async (ctx) => {
        visited.push("G3");
        assert(ctx.projectCorpus.path.endsWith("/G2/report.json"));
        assert.match(ctx.projectCorpus.sha256, /^[a-f0-9]{64}$/);
        return { id: "G3", status: "passed" };
      },
      runNativeProjectExportGate: async (ctx) => {
        visited.push("G5");
        assert.equal(ctx.exportResume, "native-project-exports.json");
        return { id: "G5", status: "passed", native_export_acceptance: true };
      },
      runPixelGate: async () => {
        throw new Error("Generic retained candidate routing is forbidden for M9");
      },
    },
  );
  assert.deepEqual(visited, ["G2", "G3", "G5"]);
  assert.equal(result.report.required_gates_passed, true);
  assert.equal(result.report.milestone_exit_satisfied, false);
});
