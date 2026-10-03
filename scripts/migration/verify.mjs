import { randomUUID } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { runPixelGate } from "../parity/pixel-gate.mjs";
import { runAppChecks } from "./app-checks.mjs";
import { runStep } from "./process.mjs";
import { writeAtomicJson } from "./report.mjs";
import { ownerProject, sourceProvenance } from "./source.mjs";
import { staticCommands } from "./static-checks.mjs";

export function parseArguments(args) {
  const options = { quick: false };
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--quick") options.quick = true;
    else if (args[index] === "--milestone" && /^M\d+$/.test(args[index + 1] ?? "")) {
      options.milestone = args[++index];
    } else if (args[index] === "--candidates" && args[index + 1]) {
      options.candidates = args[++index];
    } else throw new Error(`Unknown or incomplete argument: ${args[index]}`);
  }
  return options;
}

export async function runStaticGate(context, quick, execute) {
  const hook = await execute(
    { id: "lefthook-static", file: "pnpm", args: ["exec", "lefthook", "run", "migration-static"] },
    context,
  );
  const gate = { id: "G0", status: "failed", steps: [], hook };
  try {
    const results = JSON.parse(await readFile(join(context.output, "static-results.json"), "utf8"));
    gate.steps = results.steps;
    const expected = staticCommands();
    const complete =
      gate.steps.length === expected.length &&
      expected.every((command) => {
        const matching = gate.steps.filter((step) => step.id === command.id);
        const status = quick && !command.quick ? "skipped" : "passed";
        return matching.length === 1 && matching[0].status === status;
      });
    if (hook.status === "passed" && results.quick === quick && complete) {
      gate.status = quick ? "incomplete" : "passed";
    } else gate.error = "The lefthook run did not pass every requested static check";
  } catch (error) {
    gate.error = `Missing or invalid lefthook evidence: ${error.message}`;
  }
  gate.duration_ms = hook.duration_ms;
  return gate;
}

export async function verifyMigration(options, dependencies = {}) {
  const { root, quick = false } = options;
  const started = new Date();
  const runId = `${started.toISOString().replaceAll(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
  const output = join(root, "artifacts", "migration", runId);
  const reportPath = join(root, "artifacts", "migration", `verify-${runId}.json`);
  const report = {
    schema_version: 1,
    run_id: runId,
    started_at: started.toISOString(),
    milestone: options.milestone ?? null,
    mode: quick ? "quick" : "full",
    status: "failed",
    required_gates_passed: false,
    milestone_exit_satisfied: false,
    milestone_exit_reason:
      "Gate execution does not establish corpus, baseline or self-review completion",
    gates: [],
    runtime: { node: process.version, platform: process.platform, architecture: process.arch },
  };
  const execute = dependencies.execute ?? runStep;
  const provenance = dependencies.provenance ?? sourceProvenance;
  try {
    await mkdir(output, { recursive: true });
    const owner = await ownerProject(options.env ?? process.env);
    report.owner_performance_project = owner.report;
    report.source = await provenance(root);
    const ledger = JSON.parse(
      await readFile(join(root, "docs", "migration", "rust-renderer-progress.json"), "utf8"),
    );
    const milestone = options.milestone
      ? ledger.milestones.find((item) => item.id === options.milestone)
      : ledger.milestones.find((item) => item.status !== "done");
    if (!milestone) throw new Error("Requested milestone is missing from the migration ledger");
    report.milestone = milestone.id;
    report.required_gates = milestone.gates;
    report.open_tasks = milestone.tasks
      .filter((task) => task.status !== "done")
      .map((task) => task.id);
    const context = {
      root,
      output,
      env: {
        ...owner.env,
        ASTER_MIGRATION_RUN_DIR: output,
        ASTER_MIGRATION_QUICK: quick ? "1" : "0",
      },
      print: options.print,
    };
    if (!Array.isArray(milestone.gates) || !milestone.gates.includes("G0")) {
      throw new Error("The milestone must declare G0 and every required gate explicitly");
    }
    if (milestone.id === "M0" && !milestone.gates.includes("G6")) {
      throw new Error("M0 requires both G0 and G6 according to the migration specification");
    }
    for (const id of milestone.gates) {
      if (id === "G0") report.gates.push(await runStaticGate(context, quick, execute));
      else if (id === "G3") {
        const pixelContext = { ...context, output: join(output, "G3") };
        const build = await execute(
          {
            id: "compare-cli-build",
            file: "cargo",
            args: ["build", "--release", "-p", "aster-render-cli"],
          },
          pixelContext,
        );
        if (build.status !== "passed") {
          report.gates.push({
            id,
            status: "failed",
            error: "Pixel comparison CLI build failed",
            build,
          });
        } else {
          report.gates.push({
            ...(await (dependencies.runPixelGate ?? runPixelGate)(
              pixelContext,
              {
                manifestPath:
                  options.candidates ?? join(root, "artifacts/parity/candidate/manifest.json"),
                scope: "full",
                profileOverride: ["M1", "M2"].includes(milestone.id) ? "exact" : null,
              },
              execute,
            )),
            build,
          });
        }
      } else if (id === "G6" && milestone.id === "M0") {
        report.gates.push(
          quick
            ? { id, status: "skipped", reason: "Quick mode does not build or smoke-test the app" }
            : await runAppChecks(context, execute),
        );
      } else report.gates.push({ id, status: "failed", error: "Required gate is not implemented" });
    }
    report.source_after = await provenance(root);
    report.source_unchanged = report.source.source_sha256 === report.source_after.source_sha256;
    if (!report.source_unchanged) throw new Error("Source changed during verification; run again");
    const failed = report.gates.some((gate) => gate.status === "failed");
    report.required_gates_passed = !quick && report.gates.every((gate) => gate.status === "passed");
    report.status = failed ? "failed" : report.required_gates_passed ? "passed" : "incomplete";
  } catch (error) {
    report.error = error.stack ?? error.message;
  }
  report.finished_at = new Date().toISOString();
  report.duration_ms = Date.now() - started.getTime();
  await writeAtomicJson(reportPath, report);
  options.print?.(
    [
      `${report.milestone ?? "unknown"} ${report.mode}: ${report.status}`,
      ...report.gates.map(
        (gate) => `  ${gate.id}: ${gate.status}${gate.error ? ` — ${gate.error}` : ""}`,
      ),
      `Full required gates: ${report.required_gates_passed ? "passed" : "not satisfied"}`,
      `Milestone exit: not evaluated; use the ledger and milestone exit evidence`,
      `Report: ${relative(root, reportPath)}`,
    ].join("\n"),
  );
  return {
    report,
    reportPath,
    exitCode: report.status === "failed" || (!quick && !report.required_gates_passed) ? 1 : 0,
  };
}
