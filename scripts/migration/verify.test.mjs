import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import test from "node:test";
import { runStep } from "./process.mjs";
import { writeAtomicJson } from "./report.mjs";
import { ownerProject } from "./source.mjs";
import { runStaticChecks, staticCommands } from "./static-checks.mjs";
import { parseArguments, runStaticGate, verifyMigration } from "./verify.mjs";

async function fixture(t, gates = ["G0", "G6"]) {
  const root = await mkdtemp(join(tmpdir(), "aster-migration-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const ledger = join(root, "docs", "migration", "rust-renderer-progress.json");
  await writeAtomicJson(ledger, {
    status: "running",
    milestones: [
      { id: "M0", status: "in_progress", gates, tasks: [{ id: "M0-T1", status: "pending" }] },
    ],
  });
  return { root, ledger, output: join(root, "logs"), env: process.env };
}

async function fakeHook(command, context) {
  assert.equal(command.id, "lefthook-static");
  await runStaticChecks(context, context.env.ASTER_MIGRATION_QUICK === "1", async (step) => ({
    id: step.id,
    status: "passed",
  }));
  return { id: command.id, status: "passed", duration_ms: 1 };
}

const provenance = async () => ({ source_sha256: "source-123", commit: "123", dirty: true });

test("argument parser rejects accidental unsupported or incomplete options", () => {
  assert.deepEqual(parseArguments(["--milestone", "M0", "--quick"]), {
    milestone: "M0",
    quick: true,
  });
  assert.throws(() => parseArguments(["--milestone"]));
  assert.throws(() => parseArguments(["--skip-g6"]));
});

test("atomic report publication never exposes a partial report and removes failed temp files", async (t) => {
  const context = await fixture(t);
  const path = join(context.root, "report.json");
  const original = { status: "passed", payload: "a".repeat(20_000) };
  await writeAtomicJson(path, original);
  const invalid = { cycle: null };
  invalid.cycle = invalid;
  await assert.rejects(writeAtomicJson(path, invalid));
  assert.deepEqual(JSON.parse(await readFile(path, "utf8")), original);
  assert(!(await readdir(context.root)).some((name) => name.endsWith(".tmp")));
  await writeAtomicJson(path, { status: "failed" });
  assert.deepEqual(JSON.parse(await readFile(path, "utf8")), { status: "failed" });
});

test("failed child commands retain exit code, logs and timings", async (t) => {
  const context = await fixture(t);
  const step = await runStep(
    {
      id: "failed-child",
      file: "node",
      args: ["-e", "console.error('intentional failure');process.exit(7)"],
    },
    context,
  );
  assert.equal(step.status, "failed");
  assert.equal(step.exit_code, 7);
  assert(step.duration_ms >= 0);
  assert.match(await readFile(join(context.root, step.log), "utf8"), /intentional failure/);
});

test("log stream failure terminates the child and returns failure without hanging", {
  timeout: 5_000,
}, async (t) => {
  const context = await fixture(t);
  const step = await runStep(
    { id: "failed-log", file: "node", args: ["-e", "setInterval(()=>{},1000)"] },
    context,
    {
      createLogStream: () =>
        new Writable({
          write(_chunk, _encoding, callback) {
            callback(new Error("disk full"));
          },
        }),
    },
  );
  assert.equal(step.status, "failed");
  assert.match(step.error, /disk full/);
});

test("timeout is a failure even when a child would otherwise remain alive", {
  timeout: 10_000,
}, async (t) => {
  const context = await fixture(t);
  const step = await runStep(
    { id: "timeout", file: "node", args: ["-e", "setInterval(()=>{},1000)"], timeout_ms: 50 },
    context,
  );
  assert.equal(step.status, "failed");
  assert.match(step.error, /exceeded 50 ms/);
});

test("a zero-exit lefthook without step evidence cannot pass G0", async (t) => {
  const context = await fixture(t);
  const gate = await runStaticGate(context, false, async () => ({ status: "passed" }));
  assert.equal(gate.status, "failed");
  assert.match(gate.error, /Missing or invalid/);
});

test("full static failure propagates while every required check is still recorded", async (t) => {
  const context = await fixture(t);
  const gate = await runStaticGate(context, false, async () => {
    await runStaticChecks(context, false, async (command) => ({
      id: command.id,
      status: command.id === "cargo-test" ? "failed" : "passed",
    }));
    return { status: "passed" };
  });
  assert.equal(gate.status, "failed");
  assert.equal(gate.steps.length, staticCommands().length);
});

test("quick succeeds only as incomplete and never claims full gates or milestone exit", async (t) => {
  const context = await fixture(t);
  const result = await verifyMigration(
    { ...context, quick: true },
    { execute: fakeHook, provenance },
  );
  assert.equal(result.exitCode, 0);
  assert.equal(result.report.status, "incomplete");
  assert.equal(result.report.required_gates_passed, false);
  assert.equal(result.report.milestone_exit_satisfied, false);
  assert.equal(result.report.gates.find((gate) => gate.id === "G6").status, "skipped");
  const saved = JSON.parse(await readFile(result.reportPath, "utf8"));
  assert.deepEqual(saved, result.report);
});

test("unknown required gates fail closed even in quick mode", async (t) => {
  const context = await fixture(t, ["G0", "G6", "G99"]);
  const result = await verifyMigration(
    { ...context, quick: true },
    { execute: fakeHook, provenance },
  );
  assert.equal(result.exitCode, 1);
  assert.equal(result.report.status, "failed");
  assert.equal(result.report.gates.at(-1).id, "G99");
  assert.match(result.report.gates.at(-1).error, /not implemented/);
});

test("missing pixel evidence and omitted M0 G6 cannot produce green reports", async (t) => {
  for (const gates of [["G0", "G6", "G3"], ["G0"]]) {
    const context = await fixture(t, gates);
    const result = await verifyMigration(
      { ...context, quick: true },
      { execute: fakeHook, provenance },
    );
    assert.equal(result.exitCode, 1);
    assert.equal(result.report.required_gates_passed, false);
  }
});

test("a full non-exact pixel gate without self-review cannot authorize a commit", async (t) => {
  const context = await fixture(t);
  await writeAtomicJson(context.ledger, {
    status: "running",
    milestones: [{ id: "M3", status: "in_progress", gates: ["G0", "G3"], tasks: [] }],
  });
  const result = await verifyMigration(context, {
    provenance,
    execute: (command, context) =>
      command.id === "compare-cli-build" ? { status: "passed" } : fakeHook(command, context),
    runPixelGate: async (_context, options) => {
      assert.equal(options.scope, "full");
      assert.equal(options.profileOverride, null);
      return { id: "G3", status: "incomplete", reason: "review missing" };
    },
  });
  assert.equal(result.report.status, "incomplete");
  assert.equal(result.report.required_gates_passed, false);
  assert.equal(result.exitCode, 1);
});

test("source edits during verification invalidate successful checks", async (t) => {
  const context = await fixture(t);
  let count = 0;
  const result = await verifyMigration(
    { ...context, quick: true },
    { execute: fakeHook, provenance: async () => ({ source_sha256: String(count++) }) },
  );
  assert.equal(result.exitCode, 1);
  assert.equal(result.report.source_unchanged, false);
  assert.match(result.report.error, /Source changed/);
});

test("M1 and M2 delegate one TS verification and preserve incomplete milestone exit", async (t) => {
  for (const milestone of ["M1", "M2"]) {
    for (const passed of [true, false]) {
      const context = await fixture(t);
      await writeAtomicJson(context.ledger, {
        status: "running",
        milestones: [
          {
            id: milestone,
            status: "in_progress",
            gates: ["G0", "G3"],
            tasks: [{ id: `${milestone}-T1`, status: "in_progress" }],
          },
        ],
      });
      let verifications = 0;
      const result = await verifyMigration(
        { ...context, candidates: "fresh/manifest.json" },
        {
          provenance,
          execute: fakeHook,
          verifyTsPixels: async (options) => {
            verifications++;
            assert.equal(options.candidates, "fresh/manifest.json");
            assert.equal(options.milestone, milestone);
            return {
              exitCode: passed ? 0 : 1,
              reportPath: join(context.root, "ts-report.json"),
              report: {
                status: passed ? "passed" : "failed",
                source_unchanged: passed,
                error: passed ? undefined : "Stale TS candidate",
                // The aggregate wrapper must preserve a provenance failure even if pixels matched.
                gate: { id: "G3", status: "passed", full_coverage: true },
                build: { status: "passed", exit_code: 0 },
              },
            };
          },
        },
      );
      assert.equal(verifications, 1);
      assert.equal(result.report.gates[1].status, passed ? "passed" : "failed");
      assert.equal(result.report.required_gates_passed, passed);
      assert.equal(result.report.milestone_exit_satisfied, false);
      assert.equal(result.exitCode, passed ? 0 : 1);
      assert.equal(result.report.gates[1].ts_verification, "ts-report.json");
    }
  }
});

test("M1 refuses a missing candidate file without accepting cached gate status", async (t) => {
  const context = await fixture(t);
  await writeAtomicJson(context.ledger, {
    status: "running",
    milestones: [{ id: "M1", status: "in_progress", gates: ["G0", "G3"], tasks: [] }],
  });
  const result = await verifyMigration(context, { provenance, execute: fakeHook });
  assert.equal(result.exitCode, 1);
  assert.equal(result.report.gates[1].status, "failed");
  assert.match(result.report.gates[1].error, /ENOENT/);
});

test("TS candidate selection prefers explicit input, then the active ledger capture, then the default path", async (t) => {
  for (const [explicit, active, expected] of [
    ["explicit/manifest.json", "active/manifest.json", "explicit/manifest.json"],
    [undefined, "active/manifest.json", "active/manifest.json"],
    [undefined, undefined, "artifacts/parity/candidate/manifest.json"],
  ]) {
    const context = await fixture(t);
    await writeAtomicJson(context.ledger, {
      status: "running",
      milestones: [
        {
          id: "M1",
          status: "in_progress",
          gates: ["G0", "G3"],
          tasks: [],
          active_candidate_manifest: active,
        },
      ],
    });
    const result = await verifyMigration(
      { ...context, candidates: explicit },
      {
        provenance,
        execute: fakeHook,
        verifyTsPixels: async (options) => {
          assert.equal(options.candidates, expected);
          return {
            exitCode: 1,
            reportPath: join(context.root, "failed.json"),
            report: { status: "failed" },
          };
        },
      },
    );
    assert.equal(result.exitCode, 1);
  }
});

test("unknown milestones emit an atomic failure report", async (t) => {
  const context = await fixture(t);
  const result = await verifyMigration({ ...context, milestone: "M99" }, { provenance });
  assert.equal(result.exitCode, 1);
  assert.equal(JSON.parse(await readFile(result.reportPath, "utf8")).status, "failed");
});

test("M0 exit audit is required at the exit task and cannot override failed gates", async (t) => {
  for (const outcome of ["passed", "missing-evidence", "failed-gate", "quick"]) {
    const context = await fixture(t);
    await writeAtomicJson(context.ledger, {
      status: "running",
      milestones: [
        {
          id: "M0",
          status: "in_progress",
          gates: ["G0", "G6"],
          tasks: [{ id: "M0-T6", status: "in_progress" }],
        },
      ],
    });
    let audited = false;
    const result = await verifyMigration(
      { ...context, quick: outcome === "quick" },
      {
        provenance,
        execute: fakeHook,
        runAppChecks: async () => ({
          id: "G6",
          status: outcome === "failed-gate" ? "failed" : "passed",
        }),
        auditM0Exit: async () => {
          audited = true;
          if (outcome === "missing-evidence") throw new Error("Missing exact evidence");
          return { status: "passed" };
        },
      },
    );
    assert.equal(audited, outcome !== "quick");
    assert.equal(result.report.milestone_exit_satisfied, outcome === "passed");
    assert.equal(result.exitCode, ["passed", "quick"].includes(outcome) ? 0 : 1);
    if (outcome === "missing-evidence") {
      assert.equal(result.report.required_gates_passed, true);
      assert.equal(result.report.status, "failed");
      assert.match(result.report.milestone_exit_reason, /Missing exact/);
    }
  }
});

test("M1 exit requires current full gates, native shader smoke and complete-source audit", async (t) => {
  for (const outcome of [
    "passed",
    "audit-failed",
    "smoke-failed",
    "pixel-failed",
    "quick",
    "marked-done",
  ]) {
    const context = await fixture(t);
    await writeAtomicJson(context.ledger, {
      status: "running",
      milestones: [
        {
          id: "M1",
          status: outcome === "marked-done" ? "done" : "in_progress",
          gates: ["G0", "G3"],
          tasks: [{ id: "M1-T6", status: "in_progress" }],
        },
      ],
    });
    let smoked = false;
    let audited = false;
    const result = await verifyMigration(
      { ...context, milestone: "M1", quick: outcome === "quick" },
      {
        provenance,
        execute: fakeHook,
        verifyTsPixels: async () => ({
          exitCode: outcome === "pixel-failed" ? 1 : 0,
          reportPath: join(context.root, "exact.json"),
          report: { status: outcome === "pixel-failed" ? "failed" : "passed", gate: { id: "G3" } },
        }),
        runEffectShotSmoke: async () => {
          smoked = true;
          return { status: outcome === "smoke-failed" ? "failed" : "passed" };
        },
        auditM1Exit: async (root, report) => {
          audited = true;
          assert.equal(root, context.root);
          assert.equal(report.native_effect_shots.status, "passed");
          if (outcome === "audit-failed") throw new Error("Inline WGSL remains");
          return { status: "passed" };
        },
      },
    );
    assert.equal(smoked, !["pixel-failed", "quick"].includes(outcome));
    assert.equal(audited, !["smoke-failed", "pixel-failed", "quick"].includes(outcome));
    assert.equal(
      result.report.milestone_exit_satisfied,
      ["passed", "marked-done"].includes(outcome),
    );
    assert.equal(result.exitCode, ["passed", "quick", "marked-done"].includes(outcome) ? 0 : 1);
    if (outcome === "audit-failed") {
      assert.equal(result.report.required_gates_passed, true);
      assert.equal(result.report.status, "failed");
    }
  }
});

test("owner project preserves configured values and reports unavailable paths as skipped", async (t) => {
  const context = await fixture(t);
  const path = join(context.root, "owner");
  await mkdir(path);
  await writeFile(join(path, "project.json"), "{}");
  const found = await ownerProject({ ASTER_PERF_PROJECT: path }, "win32");
  assert.equal(found.env.ASTER_PERF_PROJECT, path);
  assert.equal(found.report.available, true);
  const missing = await ownerProject({ ASTER_PERF_PROJECT: "" }, "win32");
  assert.equal(missing.env.ASTER_PERF_PROJECT, "");
  assert.equal(missing.report.status, "skipped");
  const fallback = await ownerProject({}, "win32");
  assert.equal(fallback.env.ASTER_PERF_PROJECT, "D:\\code\\SD04PV");
});
