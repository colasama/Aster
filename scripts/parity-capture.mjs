import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import electron from "electron";
import { build, preview } from "vite";
import { runStep } from "./migration/process.mjs";
import { writeAtomicJson } from "./migration/report.mjs";
import { sourceProvenance } from "./migration/source.mjs";
import { publishCandidateCapture } from "./parity/candidate-capture.mjs";
import { publishCaptures } from "./parity/capture-store.mjs";
import { captureAssignments, captureSource, digest } from "./parity/provenance.mjs";

const root = resolve(import.meta.dirname, "..");
const selected = [];
let force = false;
let candidate = false;
let timeoutMs = 120_000;
for (let index = 2; index < process.argv.length; index++) {
  const value = process.argv[index];
  if (value === "--case" && process.argv[index + 1]) selected.push(process.argv[++index]);
  else if (value === "--force") force = true;
  else if (value === "--candidate") candidate = true;
  else if (value === "--timeout-ms" && /^\d+$/.test(process.argv[index + 1] ?? ""))
    timeoutMs = Number(process.argv[++index]);
  else throw new Error(`Unknown or incomplete capture argument: ${value}`);
}
if (timeoutMs < 1000 || timeoutMs > 1_200_000)
  throw new Error("Capture timeout must be 1000..1200000 ms per case");
process.env.ASTER_PERF_PROJECT ??= process.platform === "win32" ? "D:\\code\\SD04PV" : "";
const corpus = JSON.parse(await readFile(join(root, "tests", "parity", "corpus.json"), "utf8"));
for (const id of selected) {
  if (!corpus.cases.some((item) => item.id === id)) throw new Error(`Unknown parity case ${id}`);
}
const cases = corpus.cases.filter((item) => selected.length === 0 || selected.includes(item.id));
if (cases.some((item) => !/^[a-z0-9-]+$/.test(item.id))) throw new Error("Unsafe corpus case id");
const runId = `${new Date().toISOString().replaceAll(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
const runDirectory = join(root, "artifacts", "parity", "runs", runId);
await mkdir(runDirectory, { recursive: true });
const context = { root, output: runDirectory, env: process.env, print: console.log };
const sourceBeforeBuild = await sourceProvenance(root);
for (const command of [
  { id: "capture-electron-build", file: "pnpm", args: ["electron:compile"] },
  {
    id: "capture-bridge-build",
    file: "cargo",
    args: ["build", "--release", "-p", "aster-desktop-bridge"],
  },
]) {
  const result = await runStep(command, context);
  if (result.status !== "passed") throw new Error(`Capture prerequisite failed: ${command.id}`);
}
const source = await captureSource(root);
if (sourceBeforeBuild.source_sha256 !== source.tree_sha256)
  throw new Error(
    "Source changed while building capture prerequisites; discard the generated code",
  );
const assignments = await captureAssignments(root, cases);
const output = join(runDirectory, "web");
await build({
  configFile: false,
  root,
  logLevel: "warn",
  base: "/",
  define: { __APP_VERSION__: JSON.stringify("parity-capture") },
  build: {
    outDir: output,
    emptyOutDir: true,
    rolldownOptions: { input: join(root, "tests", "parity", "harness.html") },
  },
});
const server = await preview({
  configFile: false,
  root,
  build: { outDir: output },
  preview: { host: "127.0.0.1", port: 0 },
});
let report;
const config = {
  root,
  runId,
  runDirectory,
  source,
  assignments,
  timeoutMs,
  force,
  candidate,
  url: new URL("tests/parity/harness.html", server.resolvedUrls.local[0]).href,
};
const configPath = join(runDirectory, "config.json");
await writeAtomicJson(configPath, config);
try {
  const env = { ...process.env, ASTER_PARITY_CONFIG: configPath };
  delete env.ELECTRON_RUN_AS_NODE;
  const exitCode = await new Promise((resolveExit, reject) => {
    const child = spawn(electron, [join(root, "scripts", "parity", "electron-main.mjs")], {
      cwd: root,
      env,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.pipe(process.stdout);
    child.stderr.pipe(process.stderr);
    const timer = setTimeout(
      () => {
        if (process.platform === "win32" && Number.isSafeInteger(child.pid))
          spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
            windowsHide: true,
            stdio: "ignore",
            timeout: 5000,
          });
        child.kill();
        reject(new Error("Capture process exceeded its total deadline"));
      },
      timeoutMs * (cases.length + 1),
    );
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolveExit(code);
    });
  });
  report = JSON.parse(await readFile(join(runDirectory, "report.json"), "utf8"));
  const after = await captureSource(root);
  const inputsAfter = await captureAssignments(root, cases);
  report.source_unchanged =
    source.tree_sha256 === after.tree_sha256 &&
    source.renderer_source_sha256 === after.renderer_source_sha256 &&
    digest(assignments) === digest(inputsAfter);
  report.source = source;
  report.source_after = after;
  report.run_id = runId;
  report.exit_code = exitCode;
  report.selected_cases = cases.map((item) => item.id);
  if (!report.source_unchanged) {
    report.status = "failed";
    report.error = "Source or case resources changed during capture; images were not published";
  }
  if (
    exitCode !== 0 ||
    digest(report.cases.map((item) => item.id).sort()) !==
      digest(cases.map((item) => item.id).sort()) ||
    report.cases.some((item) => !["passed", "cached"].includes(item.status))
  )
    report.status = "failed";
  if (report.status === "passed") {
    if (candidate) report.candidate = await publishCandidateCapture(config, report);
    else await publishCaptures(config, report);
  }
  process.exitCode = report.status === "passed" ? 0 : 1;
} catch (error) {
  report = {
    status: "failed",
    run_id: runId,
    source,
    error: error.stack ?? error.message,
    cases: [],
  };
  process.exitCode = 1;
} finally {
  report.capture_mode = candidate ? "candidate" : "reference";
  await new Promise((resolveClose, reject) =>
    server.httpServer.close((error) => (error ? reject(error) : resolveClose())),
  );
  await writeAtomicJson(join(runDirectory, "report.json"), report);
  const reportPath = join(root, "artifacts", "parity", `capture-${runId}.json`);
  await writeAtomicJson(reportPath, report);
  console.log(
    `${candidate ? "Candidate" : "Reference"} capture ${report.status}: ${report.cases.filter((item) => ["passed", "cached"].includes(item.status)).length}/${cases.length} cases`,
  );
  console.log(`Report: ${reportPath}`);
  if (report.candidate) console.log(`Candidate manifest: ${report.candidate.manifest}`);
}
