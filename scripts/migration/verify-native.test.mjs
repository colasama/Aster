import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { writeAtomicJson } from "./report.mjs";
import { verifyMigration } from "./verify.mjs";
import { deliveryPolicy, fakeHook, fixture, provenance } from "./verify-fixtures.mjs";

test("M10 font increments execute native GPU checks without claiming text migration acceptance", async (t) => {
  const context = await fixture(t);
  await writeAtomicJson(context.ledger, {
    status: "running",
    milestones: [
      {
        id: "M10",
        status: "in_progress",
        gates: ["G0", "G3"],
        tasks: [{ id: "M10-T1", status: "in_progress" }],
      },
    ],
  });
  let nativeCalls = 0;
  const result = await verifyMigration(context, {
    provenance,
    execute: fakeHook,
    runNativeCoreGate: async (nativeContext) => {
      assert.equal(nativeContext.milestone, "M10");
      nativeCalls += 1;
      return { id: "G3", status: "passed", native_gpu_execution: true };
    },
    runPixelGate: async () => {
      throw new Error("Existing candidate pixels cannot establish native execution");
    },
  });
  assert.equal(nativeCalls, 1);
  assert.equal(result.report.required_gates_passed, true);
  assert.equal(result.report.milestone_exit_satisfied, false);
  assert.match(result.report.milestone_exit_reason, /per-glyph layout parity/);
  assert.equal(result.exitCode, 0);
});

test("M8 completion requires a successful exit audit after every full gate passes", async (t) => {
  for (const accepted of [false, true]) {
    const context = await fixture(t);
    await writeAtomicJson(context.ledger, {
      status: "running",
      milestones: [
        {
          id: "M8",
          status: "in_progress",
          gates: ["G0", "G3", "G4", "G5", "G6"],
          tasks: [{ id: "M8-T8", status: "in_progress" }],
        },
      ],
    });
    let audited = false;
    const result = await verifyMigration(context, {
      provenance,
      execute: fakeHook,
      runNativeCoreGate: async () => ({ id: "G3", status: "passed" }),
      runNativePerformanceGate: async () => ({ id: "G4", status: "passed" }),
      runNativeExportGate: async () => ({ id: "G5", status: "passed" }),
      runNativeAppGate: async (appContext) => {
        const report = { id: "G6", status: "passed" };
        await writeAtomicJson(join(appContext.output, "report.json"), report);
        return report;
      },
      auditM8Exit: async () => {
        audited = true;
        if (!accepted) throw new Error("Unreviewed encoded frame");
        return { status: "passed" };
      },
    });
    assert(audited);
    assert.equal(result.report.required_gates_passed, true);
    assert.equal(result.report.milestone_exit_satisfied, accepted);
    assert.equal(result.exitCode, accepted ? 0 : 1);
  }
});

test("M8 uses native pixels and never promotes session checks to export acceptance", async (t) => {
  const context = await fixture(t);
  await writeAtomicJson(context.ledger, {
    status: "running",
    milestones: [
      {
        id: "M8",
        status: "in_progress",
        gates: ["G0", "G3", "G4", "G5", "G6"],
        tasks: [{ id: "M8-T1", status: "in_progress" }],
      },
    ],
  });
  let called = false;
  const result = await verifyMigration(context, {
    provenance,
    execute: fakeHook,
    runNativePerformanceGate: async (nativeContext) => {
      assert.equal(nativeContext.milestone, "M8");
      return { id: "G4", status: "failed", error: "Native median FPS is lower" };
    },
    runNativeAppGate: async (appContext) => {
      const report = { id: "G6", status: "passed" };
      await writeAtomicJson(join(appContext.output, "report.json"), report);
      return report;
    },
    runNativeExportGate: async (nativeContext) => {
      assert.equal(nativeContext.milestone, "M8");
      assert(nativeContext.appEvidence?.sha256);
      assert.equal(JSON.parse(await readFile(nativeContext.appEvidence.path, "utf8")).id, "G6");
      return { id: "G5", status: "failed", error: "Missing corpus export quality" };
    },
    runNativeCoreGate: async (nativeContext) => {
      assert.equal(nativeContext.milestone, "M8");
      called = true;
      return { id: "G3", status: "passed", full_coverage: false, milestone_exit_eligible: false };
    },
  });
  assert(called);
  assert.equal(result.report.required_gates_passed, false);
  assert.equal(result.report.milestone_exit_satisfied, false);
  assert.equal(result.report.gates.find((g) => g.id === "G6").status, "passed");
  for (const id of ["G4", "G5"]) {
    assert.equal(result.report.gates.find((g) => g.id === id).status, "failed");
  }
  assert.equal(result.exitCode, 1);
});

test("passing native geometry gates cannot establish the full M3 exit", async (t) => {
  const context = await fixture(t);
  await writeAtomicJson(context.ledger, {
    status: "running",
    milestones: [
      {
        id: "M3",
        status: "in_progress",
        gates: ["G0", "G1", "G3"],
        tasks: [{ id: "M3-T1", status: "in_progress" }],
      },
    ],
  });
  const calls = [];
  const result = await verifyMigration(context, {
    provenance,
    execute: fakeHook,
    runIrGate: async () => ({ id: "G1", status: "passed" }),
    runNativeCoreGate: async () => {
      calls.push("native");
      return { id: "G3", status: "passed", full_coverage: false, milestone_exit_eligible: false };
    },
  });
  assert.deepEqual(calls, ["native"]);
  assert.equal(result.report.required_gates_passed, true);
  assert.equal(result.report.milestone_exit_satisfied, false);
  assert.equal(result.exitCode, 0);
});

test("M8 quick mode skips export execution without claiming full gate or milestone acceptance", async (t) => {
  const context = await fixture(t);
  await writeAtomicJson(context.ledger, {
    status: "running",
    milestones: [
      {
        id: "M8",
        status: "in_progress",
        gates: ["G0", "G3", "G4", "G5", "G6"],
        tasks: [{ id: "M8-T1", status: "in_progress" }],
      },
    ],
  });
  const result = await verifyMigration(
    { ...context, quick: true },
    {
      provenance,
      execute: fakeHook,
      runNativeExportGate: async () => {
        throw Error("Quick mode must not encode clips");
      },
    },
  );
  assert.equal(result.report.gates.find((gate) => gate.id === "G5").status, "skipped");
  assert.equal(result.report.required_gates_passed, false);
  assert.equal(result.report.milestone_exit_satisfied, false);
});

test("M5 raster increments require IR and native pixels without claiming temporal completion", async (t) => {
  const context = await fixture(t);
  await writeAtomicJson(context.ledger, {
    status: "running",
    milestones: [
      {
        id: "M5",
        status: "in_progress",
        gates: ["G0", "G1", "G3"],
        tasks: [{ id: "M5-T1", status: "in_progress" }],
      },
    ],
  });
  const calls = [];
  const result = await verifyMigration(context, {
    provenance,
    execute: fakeHook,
    runIrGate: async () => {
      calls.push("IR");
      return { id: "G1", status: "passed" };
    },
    runNativeCoreGate: async (nativeContext) => {
      assert.equal(nativeContext.milestone, "M5");
      calls.push("native");
      return { id: "G3", status: "passed", full_coverage: false, milestone_exit_eligible: false };
    },
  });
  assert.deepEqual(calls, ["IR", "native"]);
  assert.equal(result.report.required_gates_passed, true);
  assert.equal(result.report.milestone_exit_satisfied, false);
  assert.match(result.report.milestone_exit_reason, /temporal text/);
  assert.equal(result.exitCode, 0);
});

test("M6 sequence increments execute native media with no premature video completion", async (t) => {
  const context = await fixture(t);
  await writeAtomicJson(context.ledger, {
    status: "running",
    owner_overrides: { performance_delivery_policy: deliveryPolicy },
    milestones: [
      {
        id: "M6",
        status: "in_progress",
        gates: ["G0", "G3"],
        tasks: [{ id: "M6-T1", status: "in_progress" }],
      },
    ],
  });
  let called = false;
  const result = await verifyMigration(context, {
    provenance,
    execute: fakeHook,
    runNativeCoreGate: async (nativeContext) => {
      assert.equal(nativeContext.milestone, "M6");
      called = true;
      return { id: "G3", status: "passed", full_coverage: false };
    },
  });
  assert(called);
  assert.equal(result.report.required_gates_passed, true);
  assert.equal(result.report.milestone_exit_satisfied, false);
  assert.match(result.report.milestone_exit_reason, /full M6 exit audit/);
});

test("M4 effect increments execute native GPU gates without claiming complete effect coverage", async (t) => {
  const context = await fixture(t);
  await writeAtomicJson(context.ledger, {
    status: "running",
    owner_overrides: { performance_delivery_policy: deliveryPolicy },
    milestones: [
      {
        id: "M4",
        status: "in_progress",
        gates: ["G0", "G3"],
        tasks: [{ id: "M4-T1", status: "in_progress" }],
      },
    ],
  });
  const result = await verifyMigration(context, {
    provenance,
    execute: fakeHook,
    runNativeCoreGate: async (nativeContext) => {
      assert.equal(nativeContext.milestone, "M4");
      return { id: "G3", status: "passed", full_coverage: false, milestone_exit_eligible: false };
    },
  });
  assert.equal(result.report.required_gates_passed, true);
  assert.equal(result.report.milestone_exit_satisfied, false);
  assert.match(result.report.milestone_exit_reason, /M4 exit audit/);
});

test("M4 completion invokes its evidence audit and propagates rejection", async (t) => {
  for (const failed of [false, true]) {
    const context = await fixture(t);
    await writeAtomicJson(context.ledger, {
      status: "running",
      owner_overrides: { performance_delivery_policy: deliveryPolicy },
      milestones: [
        {
          id: "M4",
          status: "in_progress",
          gates: ["G0", "G3"],
          tasks: [{ id: "M4-T6", status: "in_progress" }],
        },
      ],
    });
    let audits = 0;
    const result = await verifyMigration(context, {
      provenance,
      execute: fakeHook,
      runNativeCoreGate: async () => ({ id: "G3", status: "passed", full_coverage: true }),
      auditM4Exit: async () => {
        audits++;
        if (failed) throw new Error("Missing effect output");
        return { status: "passed" };
      },
    });
    assert.equal(audits, 1);
    assert.equal(result.report.milestone_exit_satisfied, !failed);
    assert.equal(result.exitCode, failed ? 1 : 0);
  }
});

test("M5 completion requires a successful exit audit even when all gates pass", async (t) => {
  for (const accepted of [false, true]) {
    const context = await fixture(t);
    await writeAtomicJson(context.ledger, {
      status: "running",
      milestones: [
        {
          id: "M5",
          status: "in_progress",
          gates: ["G0", "G1", "G3"],
          tasks: [{ id: "M5-T4", status: "in_progress" }],
        },
      ],
    });
    let audited = false;
    const result = await verifyMigration(context, {
      provenance,
      execute: fakeHook,
      runIrGate: async () => ({ id: "G1", status: "passed" }),
      runNativeCoreGate: async () => ({ id: "G3", status: "passed", full_coverage: true }),
      auditM5Exit: async () => {
        audited = true;
        if (!accepted) throw new Error("Missing temporal evidence");
        return { status: "passed" };
      },
    });
    assert(audited);
    assert.equal(result.report.required_gates_passed, true);
    assert.equal(result.report.milestone_exit_satisfied, accepted);
    assert.equal(result.exitCode, accepted ? 0 : 1);
  }
});

test("M6 completion requires a successful exit audit even when all gates pass", async (t) => {
  for (const accepted of [false, true]) {
    const context = await fixture(t);
    await writeAtomicJson(context.ledger, {
      status: "running",
      milestones: [
        {
          id: "M6",
          status: "in_progress",
          gates: ["G0", "G3"],
          tasks: [{ id: "M6-T4", status: "in_progress" }],
        },
      ],
    });
    let audited = false;
    const result = await verifyMigration(context, {
      provenance,
      execute: fakeHook,
      runIrGate: async () => ({ id: "G1", status: "passed" }),
      runNativeCoreGate: async () => ({ id: "G3", status: "passed", full_coverage: true }),
      auditM6Exit: async () => {
        audited = true;
        if (!accepted) throw new Error("Missing native media evidence");
        return { status: "passed" };
      },
    });
    assert(audited);
    assert.equal(result.report.required_gates_passed, true);
    assert.equal(result.report.milestone_exit_satisfied, accepted);
    assert.equal(result.exitCode, accepted ? 0 : 1);
  }
});

test("M7 completion requires a successful exit audit even when all gates pass", async (t) => {
  for (const accepted of [false, true]) {
    const context = await fixture(t);
    await writeAtomicJson(context.ledger, {
      status: "running",
      milestones: [
        {
          id: "M7",
          status: "in_progress",
          gates: ["G0", "G3"],
          tasks: [{ id: "M7-T6", status: "in_progress" }],
        },
      ],
    });
    let audited = false;
    const result = await verifyMigration(context, {
      provenance,
      execute: fakeHook,
      runIrGate: async () => ({ id: "G1", status: "passed" }),
      runNativeCoreGate: async () => ({ id: "G3", status: "passed", full_coverage: true }),
      auditM7Exit: async () => {
        audited = true;
        if (!accepted) throw new Error("Missing native scene evidence");
        return { status: "passed" };
      },
    });
    assert(audited);
    assert.equal(result.report.required_gates_passed, true);
    assert.equal(result.report.milestone_exit_satisfied, accepted);
    assert.equal(result.exitCode, accepted ? 0 : 1);
  }
});
