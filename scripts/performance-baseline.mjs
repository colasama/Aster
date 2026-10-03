import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import electron from "electron";
import { build, preview } from "vite";
import { runStep } from "./migration/process.mjs";
import { writeAtomicJson } from "./migration/report.mjs";
import { hashFile, sourceProvenance } from "./migration/source.mjs";
import { captureAssignments, captureSource, digest } from "./parity/provenance.mjs";
import { performanceEligibility } from "./performance/eligibility.mjs";
import { capturePerformanceHardware } from "./performance/hardware.mjs";
import { summarizePerformance } from "./performance/statistics.mjs";
import { prepareWorkloads, scheduleWorkloads } from "./performance/workloads.mjs";

const root = resolve(import.meta.dirname, "..");
const selected = [];
const modes = [];
let smoke = false;
for (let index = 2; index < process.argv.length; index++) {
  const argument = process.argv[index];
  if (argument === "--case" && process.argv[index + 1]) selected.push(process.argv[++index]);
  else if (argument === "--mode" && process.argv[index + 1]) modes.push(process.argv[++index]);
  else if (argument === "--smoke") smoke = true;
  else throw new Error(`Unknown or incomplete benchmark argument: ${argument}`);
}
process.env.ASTER_PERF_PROJECT ??= process.platform === "win32" ? "D:\\code\\SD04PV" : "";
const runId = `${new Date().toISOString().replaceAll(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
const runDirectory = join(root, "artifacts", "performance", runId);
await mkdir(runDirectory, { recursive: true });
const context = { root, output: runDirectory, env: process.env, print: console.log };
let report = { schema_version: 1, run_id: runId, status: "failed", cases: [] };
let server;
try {
  const sourceBeforeBuild = await sourceProvenance(root);
  for (const command of [
    { id: "performance-electron-build", file: "pnpm", args: ["electron:compile"] },
    {
      id: "performance-bridge-build",
      file: "cargo",
      args: ["build", "--release", "-p", "aster-desktop-bridge"],
    },
  ]) {
    const result = await runStep(command, context);
    if (result.status !== "passed")
      throw new Error(`Performance prerequisite failed: ${command.id}`);
  }
  const workloads = await prepareWorkloads(root);
  const requested = scheduleWorkloads(workloads, { selected, modes, smoke });
  const skipped = requested
    .filter((item) => item.unavailable)
    .map((item) => ({
      id: item.benchmark.id,
      status: "skipped",
      reason: item.unavailable,
    }));
  const assignments = requested.filter((item) => !item.unavailable);
  if (assignments.length === 0) throw new Error("No performance projects are available");
  const output = join(runDirectory, "web");
  await build({
    configFile: false,
    root,
    logLevel: "warn",
    base: "/",
    define: { __APP_VERSION__: JSON.stringify("migration-performance") },
    build: {
      outDir: output,
      emptyOutDir: true,
      rolldownOptions: { input: join(root, "tests", "performance", "harness.html") },
    },
  });
  server = await preview({
    configFile: false,
    root,
    build: { outDir: output },
    preview: { host: "127.0.0.1", port: 0 },
  });
  const source = await captureSource(root);
  if (sourceBeforeBuild.source_sha256 !== source.tree_sha256)
    throw new Error("Source changed while building the benchmark; discard the generated bundle");
  const hardware = await capturePerformanceHardware(root);
  const hardwareManifest = JSON.parse(
    await readFile(join(root, "benchmarks", "hardware", "windows-radeon780m-local.json"), "utf8"),
  );
  const suffix = process.platform === "win32" ? ".exe" : "";
  const binaries = {
    ffmpeg: resolve(
      process.env.ASTER_FFMPEG_PATH ?? join(root, "build", "ffmpeg", `ffmpeg${suffix}`),
    ),
    ffprobe: resolve(
      process.env.ASTER_FFPROBE_PATH ?? join(root, "build", "ffmpeg", `ffprobe${suffix}`),
    ),
  };
  const ffmpeg = Object.fromEntries(
    await Promise.all(
      ["ffmpeg", "ffprobe"].map(async (name) => [name, await hashFile(binaries[name])]),
    ),
  );
  const config = {
    root,
    runId,
    runDirectory,
    source,
    hardware,
    binaries,
    assignments,
    timeoutMs: 600_000,
    url: new URL("tests/performance/harness.html", server.resolvedUrls.local[0]).href,
  };
  const configPath = join(runDirectory, "config.json");
  await writeAtomicJson(configPath, config);
  console.log(
    `Performance ${smoke ? "diagnostic" : "suite"}: ${assignments.length} runs, output ${runDirectory}`,
  );
  const env = { ...process.env, ASTER_PERFORMANCE_CONFIG: configPath };
  delete env.ELECTRON_RUN_AS_NODE;
  const exitCode = await new Promise((resolveExit, reject) => {
    const child = spawn(electron, [join(root, "scripts", "performance", "electron-main.mjs")], {
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
        reject(new Error("Performance suite exceeded its total deadline"));
      },
      config.timeoutMs * (assignments.length + 1),
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
  const hardwareAfter = await capturePerformanceHardware(root);
  const ffmpegAfter = Object.fromEntries(
    await Promise.all(
      Object.entries(binaries).map(async ([name, path]) => [name, await hashFile(path)]),
    ),
  );
  const inputsAfter = await captureAssignments(
    root,
    workloads.map((item) => item.case),
  );
  const resourceIdentity = (items) =>
    digest(
      items.map((item) => ({
        case: item.case,
        caseHash: item.caseHash,
        unavailable: item.unavailable,
      })),
    );
  const hardwareIdentity = (value) =>
    digest({
      operatingSystem: value.operatingSystem,
      cpu: value.cpu,
      memory: value.memory,
      graphicsAdapters: value.graphicsAdapters,
      displays: value.displays,
      power: value.power,
    });
  const sourceUnchanged =
    source.tree_sha256 === after.tree_sha256 &&
    source.renderer_source_sha256 === after.renderer_source_sha256 &&
    resourceIdentity(workloads) === resourceIdentity(inputsAfter) &&
    digest(ffmpeg) === digest(ffmpegAfter);
  const hardwareUnchanged = hardwareIdentity(hardware) === hardwareIdentity(hardwareAfter);
  const diagnostic = smoke || selected.length > 0 || modes.length > 0;
  const measurements = summarizePerformance(report.cases, assignments, smoke);
  report = {
    ...report,
    schema_version: 1,
    run_id: runId,
    exit_code: exitCode,
    source,
    source_after: after,
    source_unchanged: sourceUnchanged,
    hardware,
    hardware_after: hardwareAfter,
    hardware_unchanged: hardwareUnchanged,
    binaries,
    ffmpeg_sha256: ffmpeg,
    ffmpeg_sha256_after: ffmpegAfter,
    hardware_manifest: "benchmarks/hardware/windows-radeon780m-local.json",
    hardware_manifest_sha256: digest(hardwareManifest),
    skipped,
    diagnostic,
    measurements,
    method: {
      build:
        "Vite production bundle and release desktop bridge; isolated hidden Electron without throttling",
      interval:
        "RenderHost prepared to completed, including output backpressure, audio mixing and encoder flush",
      excluded: [
        "project load",
        "renderer and shader initialization",
        "warm-up",
        "audio decoding",
        "encoder probe",
      ],
      warmup: "Complete ten-frame suite (run 0) plus ten frames before each measured run",
      samples:
        "Three runs; complete owner opening and fixed 300-frame main; 600 frames for each synthetic scene",
      order: "Alternating workload order; rotating output-mode order",
      statistics:
        "R-7 linear-interpolated median/p95/p99; raw frame intervals plus distribution of three run throughputs",
      gpu_time: {
        status: "unavailable",
        reason: "Existing async profiler does not bind completed GPU samples to frame identity",
      },
      cpu_time: {
        status: "unavailable",
        reason: "Readback wall latency includes GPU and waiting; it is not CPU execution time",
      },
      frame_conversion:
        "Production BGRA/RGBA bytes; no capture-only RGBA normalization or per-frame extra complete call",
      comparison_scope:
        "Local AMD baseline series only; never compare to historical NVIDIA observations",
      pixel_validation:
        "Performance MP4 ffprobe checks do not establish G5 decoded-pixel or audio-sync acceptance",
    },
  };
  if (exitCode !== 0 || report.status !== "passed" || !sourceUnchanged || !hardwareUnchanged)
    throw new Error(
      "Performance suite failed, or its source/resources/hardware changed during measurement",
    );
  report.eligibility = performanceEligibility({
    hardware,
    hardwareAfter,
    host: report.host,
    adapter: report.adapter,
    diagnostics: report.cases.map((item) => item.result?.diagnostics ?? item.diagnostics),
    manifest: hardwareManifest,
    sourceUnchanged,
    hardwareUnchanged,
    diagnostic,
    skipped,
  });
  report.baseline_eligible = report.eligibility.eligible;
  report.status = report.baseline_eligible ? "passed" : "incomplete";
  process.exitCode = report.baseline_eligible || diagnostic ? 0 : 1;
} catch (error) {
  report = {
    ...report,
    status: "failed",
    baseline_eligible: false,
    error: error.stack ?? error.message,
  };
  process.exitCode = 1;
} finally {
  if (server)
    await new Promise((resolveClose, reject) =>
      server.httpServer.close((error) => (error ? reject(error) : resolveClose())),
    );
  await writeAtomicJson(join(runDirectory, "report.json"), report);
  const path = join(root, "artifacts", "performance", `baseline-${runId}.json`);
  await writeAtomicJson(path, report);
  console.log(`Performance ${report.status}: ${path}`);
}
