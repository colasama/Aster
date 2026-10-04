import { execFileSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { hashFile, sourceProvenance } from "../migration/source.mjs";
import { captureSource, digest } from "../parity/provenance.mjs";
import { performanceEligibility } from "./eligibility.mjs";
import { captureExecutionArtifacts } from "./execution-artifacts.mjs";
import { loadThroughputBaseline, performanceAssignments } from "./measurement-audit.mjs";
import { previewMethod, summarizePreview } from "./preview.mjs";
import { summarizePerformance } from "./statistics.mjs";

/** CPU-only evidence fixtures. Synthetic output bytes are never represented as benchmark observations. */
export async function measurementFixture(t) {
  const root = await mkdtemp(join(tmpdir(), "aster-measurement-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repository = resolve(import.meta.dirname, "../..");
  const read = async (path) => JSON.parse(await readFile(join(root, path), "utf8"));
  const write = async (path, value) => {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), `${JSON.stringify(value, null, 2)}\n`);
  };
  const basePath = "benchmarks/results/migration-baseline.json";
  const baseline = JSON.parse(await readFile(join(repository, basePath), "utf8"));
  for (const path of [
    basePath,
    baseline.hardware_manifest,
    baseline.evidence.source,
    ...baseline.measurements.map((item) => item.raw_data),
  ]) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await copyFile(join(repository, path), join(root, path));
  }
  const data = await loadThroughputBaseline(root);
  const raw = new Map();
  for (const item of baseline.measurements)
    for (const entry of await read(item.raw_data)) raw.set(entry.id, entry);
  const manifest = await read(baseline.hardware_manifest);
  const createReport = async (suite, runId = `test-${suite}`, tree, webDirectory) => {
    const source = await captureSource(root);
    tree ??= source.tree_sha256;
    const runDirectory = join(root, "artifacts/performance", runId);
    await mkdir(runDirectory, { recursive: true });
    if (webDirectory === undefined) {
      webDirectory = join(runDirectory, "web");
      await mkdir(webDirectory, { recursive: true });
      await writeFile(join(webDirectory, "harness.js"), "// CPU-only benchmark bundle stub\n");
    }
    const execution = await captureExecutionArtifacts(root, { webDirectory, runDirectory });
    const assignments = performanceAssignments(data, suite);
    const cases = [];
    for (const assignment of assignments) {
      const benchmark = assignment.benchmark;
      if (suite === "throughput") {
        const entry = structuredClone(raw.get(benchmark.id));
        if (benchmark.mode === "full-mp4") {
          const output = entry.output;
          const path = join(root, "artifacts/performance", runId, "outputs", `${benchmark.id}.mp4`);
          await mkdir(dirname(path), { recursive: true });
          await writeFile(path, "CPU test output bytes");
          output.outputPath = path;
          output.encoderReport.outputPath = path;
          output.encoderReport.bytesWritten = output.ffprobe.bytes = 21;
          output.ffprobe.sha256 = await hashFile(path);
        }
        cases.push(entry);
      } else {
        const frames = benchmark.endFrameExclusive - benchmark.startFrame;
        const diagnostics = structuredClone(
          raw.get(`${assignment.case.id}-readback-only-1`).result.diagnostics,
        );
        cases.push({
          id: benchmark.id,
          caseId: assignment.case.id,
          case_hash: assignment.caseHash,
          inputs: assignment.inputs,
          benchmark,
          status: "passed",
          output: { mode: "preview-present", outputCalls: 0 },
          result: {
            schemaVersion: 1,
            id: benchmark.id,
            benchmarkId: benchmark.id,
            caseId: assignment.case.id,
            mode: "preview-present",
            run: benchmark.run,
            frames,
            warmupFrames: 10,
            startFrame: benchmark.startFrame,
            endFrameExclusive: benchmark.endFrameExclusive,
            ...assignment.case.size,
            frameRate: benchmark.frameRate,
            pixelFormat: "bgra",
            maxInFlight: 1,
            playing: false,
            elapsedMs: frames * 10,
            framesPerSecond: 100,
            loadMs: 1,
            initializeMs: 1,
            samples: Array.from({ length: frames }, (_, index) => ({
              frame: benchmark.startFrame + index,
              presentCallMs: 1,
              presentCompletionMs: 10,
            })),
            diagnostics,
          },
        });
      }
    }
    const currentSource = { ...source, tree_sha256: tree };
    const host = { backend: "browser-webgpu", native_backend: null, cacheIdentity: baseline.host };
    const eligibility = performanceEligibility({
      hardware: baseline.hardware,
      hardwareAfter: baseline.hardware_after,
      host,
      adapter: baseline.host.webgpuAdapter,
      diagnostics: cases.map((item) => item.result.diagnostics),
      manifest,
      sourceUnchanged: true,
      hardwareUnchanged: true,
      diagnostic: false,
      skipped: [],
    });
    return {
      schema_version: 1,
      suite,
      run_id: runId,
      status: "passed",
      exit_code: 0,
      started_at: new Date().toISOString(),
      finished_at: new Date().toISOString(),
      source: currentSource,
      source_after: currentSource,
      source_before_build: { source_sha256: tree },
      source_unchanged: true,
      execution_artifacts: execution.snapshot,
      hardware: baseline.hardware,
      hardware_after: baseline.hardware_after,
      hardware_unchanged: true,
      host,
      adapter: baseline.host.webgpuAdapter,
      hardware_manifest: baseline.hardware_manifest,
      hardware_manifest_sha256: baseline.hardware_manifest_sha256,
      ffmpeg_sha256: baseline.ffmpeg_sha256,
      ffmpeg_sha256_after: baseline.ffmpeg_sha256,
      diagnostic: false,
      baseline_eligible: true,
      eligibility,
      skipped: [],
      cases,
      method: suite === "preview" ? previewMethod : baseline.method,
      measurements:
        suite === "preview"
          ? summarizePreview(cases, assignments)
          : summarizePerformance(cases, assignments, false),
    };
  };
  const git = (...args) =>
    execFileSync("git", args, { cwd: root, encoding: "utf8", windowsHide: true }).trim();
  await mkdir(join(root, "empty-hooks"));
  await writeFile(join(root, ".gitignore"), "artifacts/\nempty-hooks/\ntarget/\ndist-electron/\n");
  await mkdir(join(root, "dist-electron"));
  await writeFile(join(root, "dist-electron/main.js"), "// CPU-only Electron output stub\n");
  await mkdir(join(root, "target/release"), { recursive: true });
  await writeFile(
    join(root, `target/release/aster-desktop-bridge${process.platform === "win32" ? ".exe" : ""}`),
    "CPU test bridge identity",
  );
  await mkdir(join(root, "src"));
  await writeFile(join(root, "src/renderer.ts"), "export const renderer = 'pre-plan';\n");
  git("init", "-q");
  git("config", "core.autocrlf", "false");
  git("add", ".");
  git(
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.invalid",
    "-c",
    "commit.gpgsign=false",
    "-c",
    `core.hooksPath=${join(root, "empty-hooks")}`,
    "commit",
    "-qm",
    "🧪 Initialize performance evidence fixture",
  );
  const ledger = {
    status: "running",
    milestones: [
      {
        id: "M2",
        status: "in_progress",
        renderer_plan_complete: false,
        pre_plan_renderer_commit: git("rev-parse", "HEAD"),
        tasks: Array.from({ length: 15 }, (_, index) => ({
          id: `M2-T${index + 1}`,
          status: index === 0 ? "in_progress" : "pending",
        })),
      },
    ],
  };
  await write("docs/migration/rust-renderer-progress.json", ledger);
  let baselinePreviewRun = 0;
  const baselinePreview = async () => {
    const report = await createReport(
      "preview",
      `test-baseline-preview-${++baselinePreviewRun}`,
      (await sourceProvenance(root)).source_sha256,
    );
    await write("artifacts/preview.json", report);
    return report;
  };
  return {
    root,
    data,
    baseline,
    ledger,
    read,
    write,
    createReport,
    baselinePreview,
    hash: async (path) => hashFile(join(root, path)),
    digest,
  };
}
