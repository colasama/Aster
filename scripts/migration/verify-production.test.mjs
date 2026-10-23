import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { writeAtomicJson } from "./report.mjs";
import { verifyMigration } from "./verify.mjs";
import { fakeHook, fixture, provenance } from "./verify-fixtures.mjs";

test("M12 uses native project, combined pixels and native project export gates without claiming final acceptance", async (t) => {
  for (const mode of ["passed", "failed-corpus", "quick"]) {
    const context = await fixture(t),
      calls = [];
    await writeAtomicJson(context.ledger, {
      status: "running",
      milestones: [
        {
          id: "M12",
          status: "in_progress",
          gates: ["G0", "G1", "G2", "G3", "G4", "G5", "G6"],
          tasks: [{ id: "M12-T7", status: "in_progress" }],
        },
      ],
    });
    const result = await verifyMigration(
      { ...context, quick: mode === "quick" },
      {
        provenance,
        execute: fakeHook,
        runNativeProjectGate: async () => {
          calls.push("G1");
          return { id: "G1", status: "passed" };
        },
        runNativeProjectCorpusGate: async (ctx) => {
          calls.push("G2");
          const gate = { id: "G2", status: mode === "failed-corpus" ? "failed" : "passed" };
          await writeAtomicJson(join(ctx.output, "report.json"), gate);
          return gate;
        },
        runProductionPixelGate: async (ctx) => {
          assert(ctx.projectCorpus?.path.endsWith("G2/report.json"));
          assert.match(ctx.projectCorpus.sha256, /^[a-f0-9]{64}$/);
          calls.push("G3-combined");
          return { id: "G3", status: "passed" };
        },
        runNativeProjectExportGate: async () => {
          calls.push("G5");
          return { id: "G5", status: "passed" };
        },
        runProductionPerformanceGate: async () => {
          calls.push("G4-combined");
          return { id: "G4", status: "passed" };
        },
        runProductionAppGate: async (ctx) => {
          assert(
            ctx.previewPerformancePath.replaceAll("\\", "/").endsWith("G4/preview/report.json"),
          );
          calls.push("G6-production");
          return { id: "G6", status: "passed" };
        },
        runNativeProjectPixelGate: async () => {
          throw Error("M12 requires both project and preview pixels");
        },
        runPixelGate: async () => {
          throw Error("Retained candidates cannot replace native project execution");
        },
      },
    );
    assert.deepEqual(
      calls,
      mode === "quick"
        ? []
        : mode === "failed-corpus"
          ? ["G1", "G2", "G4-combined", "G6-production"]
          : ["G1", "G2", "G3-combined", "G4-combined", "G5", "G6-production"],
    );
    assert.equal(result.report.required_gates_passed, mode === "passed");
    assert.equal(result.report.milestone_exit_satisfied, false);
    if (mode === "failed-corpus")
      for (const id of ["G2", "G3", "G5"])
        assert.equal(result.report.gates.find((g) => g.id === id).status, "failed");
    assert.equal(
      result.report.gates.find((g) => g.id === "G4").status,
      mode === "quick" ? "skipped" : "passed",
    );
    assert.equal(
      result.report.gates.find((g) => g.id === "G6").status,
      mode === "quick" ? "skipped" : "passed",
    );
  }
});
