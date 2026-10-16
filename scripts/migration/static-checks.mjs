import { lstat } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { runStep } from "./process.mjs";
import { writeAtomicJson } from "./report.mjs";

export function staticCommands() {
  return [
    { id: "cargo-fmt", file: "cargo", args: ["fmt", "--all", "--check"], quick: true },
    {
      id: "cargo-clippy",
      file: "cargo",
      args: ["clippy", "--workspace", "--all-targets", "--all-features", "--", "-D", "warnings"],
    },
    { id: "cargo-test", file: "cargo", args: ["test", "--workspace", "--all-features"] },
    { id: "biome", file: "pnpm", args: ["exec", "biome", "check", "."], quick: true },
    { id: "typecheck", file: "pnpm", args: ["typecheck"], quick: true },
    { id: "vitest", file: "pnpm", args: ["vitest", "run", "--maxWorkers=4"] },
    { id: "packaging-tests", file: "pnpm", args: ["test:packaging"] },
    { id: "migration-tests", file: "pnpm", args: ["test:migration"], quick: true },
  ];
}

export async function runStaticChecks(context, quick, execute = runStep) {
  const reportPath = resolve(context.output, "static-results.json");
  const existing = await lstat(reportPath).catch((error) => {
    if (error.code !== "ENOENT") throw error;
    return null;
  });
  if (existing) throw new Error("Static evidence already exists; use a fresh output directory");
  const steps = [];
  for (const command of staticCommands()) {
    steps.push(
      quick && !command.quick
        ? { id: command.id, status: "skipped", reason: "Quick mode omits this required full check" }
        : await execute(command, context),
    );
    await writeAtomicJson(reportPath, { quick, steps });
  }
  return steps;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const output = process.env.ASTER_MIGRATION_RUN_DIR;
  if (!output) throw new Error("Run this hook through pnpm migrate:verify");
  const steps = await runStaticChecks(
    { root: process.cwd(), output, env: process.env, print: console.log },
    process.env.ASTER_MIGRATION_QUICK === "1",
  );
  process.exitCode = steps.some((step) => step.status === "failed") ? 1 : 0;
}
