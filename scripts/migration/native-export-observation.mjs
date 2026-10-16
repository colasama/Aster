import assert from "node:assert/strict";
import { mkdir, readFile, stat } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import electron from "electron";
import { preview } from "vite";
import { capturePerformanceHardware } from "../performance/hardware.mjs";
import { loadThroughputBaseline } from "../performance/measurement-audit.mjs";
import { loadRetainedPerformanceRuntime } from "../performance/retained-runtime.mjs";
import { distribution, summarizePerformance } from "../performance/statistics.mjs";
import { prepareWorkloads } from "../performance/workloads.mjs";
import { nativeExportWorkloads } from "./native-export-series.mjs";
import { prepareNativeObservationRuntime } from "./native-observation-runtime.mjs";
import { runStep } from "./process.mjs";
import { writeAtomicJson } from "./report.mjs";
import { hashFile, sourceProvenance } from "./source.mjs";

/** Execute one authenticated export observation; only the paired gate can accept performance. */
export async function runExportObservation(
  context,
  { cases = nativeExportWorkloads, smoke = false, run = 1, renderer = "ts", preparedNative } = {},
) {
  const { root, output } = context;
  const environment = { ...context.env, NODE_ENV: "production" };
  delete environment.ELECTRON_RUN_AS_NODE;
  const report = {
    status: "failed",
    native_export_acceptance: false,
    smoke,
    renderer,
    started_at: new Date().toISOString(),
  };
  let server;
  await mkdir(output, { recursive: true });
  try {
    assert(Number.isSafeInteger(run) && run >= 0);
    assert(
      cases.length &&
        new Set(cases).size === cases.length &&
        cases.every((id) => nativeExportWorkloads.includes(id)),
    );
    report.source = await sourceProvenance(root);
    assert(["ts", "rust"].includes(renderer));
    const retained = renderer === "ts" ? await loadRetainedPerformanceRuntime(root) : undefined;
    let native;
    if (retained) report.retained_runtime = retained.provenance;
    else {
      native = preparedNative ?? (await prepareNativeObservationRuntime(context));
      assert.equal(native.source.source_sha256, report.source.source_sha256);
      await native.assertUnchanged();
      report.build = native.build;
      report.execution_artifacts = native.execution.snapshot;
    }
    const nativeRuntime = native?.nativeRuntime;
    const workloads = await prepareWorkloads(root, environment);
    const selected = cases.map((id) => workloads.find((item) => item.case.id === id));
    assert(selected.every((item) => item && !item.unavailable));
    const pinned = await loadThroughputBaseline(root);
    for (const item of selected)
      assert.deepEqual(
        item.inputs,
        pinned.cases.get(item.case.id),
        "Reference workload differs from pinned inputs",
      );
    report.workload_baseline = {
      path: "benchmarks/results/migration-baseline.json",
      sha256: pinned.sha256,
    };
    const assignments = selected.map((item) => {
      const start = Math.min(...item.frames),
        end = Math.max(...item.frames) + 1;
      return {
        ...item,
        benchmark: {
          id: `${item.case.id}-${renderer === "ts" ? "retained" : "native"}-full-mp4-${run}`,
          mode: "full-mp4",
          requireAudio: item.case.id.startsWith("owner-"),
          ...(renderer === "rust" ? { renderer: "rust" } : {}),
          run,
          frameRate: item.frameRate,
          warmupFrames: 10,
          startFrame: start,
          endFrameExclusive: smoke || run === 0 ? Math.min(start + 10, end) : end,
        },
      };
    });
    report.assignments = assignments;
    report.hardware = await capturePerformanceHardware(root);
    assert.equal(report.hardware.runConditions.baselineEligible, true);
    const binaries = {
      ffmpeg: join(root, "build/ffmpeg/ffmpeg.exe"),
      ffprobe: join(root, "build/ffmpeg/ffprobe.exe"),
    };
    report.binaries = {};
    for (const [key, file] of Object.entries({
      ...binaries,
      electron,
      ...(nativeRuntime
        ? { renderer: nativeRuntime.binary, compiler: nativeRuntime.compiler }
        : {}),
    }))
      report.binaries[key] = {
        path: relative(root, file).replaceAll("\\", "/"),
        sha256: await hashFile(file),
      };
    server = await preview({
      configFile: false,
      root,
      build: { outDir: retained?.browser.directory ?? native.webDirectory },
      preview: { host: "127.0.0.1", port: 0 },
    });
    const runDirectory = join(output, "execution");
    const configPath = join(output, "config.json");
    await writeAtomicJson(configPath, {
      root,
      suite: "throughput",
      runId: `${renderer}-export-${Date.now()}`,
      runDirectory,
      source: retained?.browser.rendererSource ?? report.source,
      hardware: report.hardware,
      binaries,
      assignments,
      retainedRuntime: !!retained,
      ...(nativeRuntime ? { nativeRuntime } : {}),
      timeoutMs: 900000,
      url: new URL("tests/performance/harness.html", server.resolvedUrls.local[0]).href,
    });
    const child = await runStep(
      {
        id: `${renderer}-export-observation`,
        file: electron,
        args: ["scripts/performance/electron-main.mjs"],
        env: { ASTER_PERFORMANCE_CONFIG: configPath },
        timeout_ms: 900000 * (assignments.length + 1),
      },
      { ...context, env: environment },
    );
    report.execution = child;
    const path = join(runDirectory, "report.json");
    report.raw = { path: relative(root, path).replaceAll("\\", "/"), sha256: await hashFile(path) };
    const raw = JSON.parse(await readFile(path, "utf8"));
    assert.equal(child.status, "passed", raw.error);
    assert.equal(raw.status, "passed", raw.error);
    if (retained) {
      assert.deepEqual(raw.retained_runtime, retained.provenance);
      report.measurements = summarizePerformance(raw.cases, assignments, true);
    } else {
      assert.equal(raw.cases.length, assignments.length);
      report.measurements = raw.cases.map((entry, index) => {
        const result = entry.result;
        assert.equal(entry.status, "passed");
        assert.equal(result.id, assignments[index].benchmark.id);
        assert.equal(result.renderer, "rust");
        assert.equal(entry.output.transport.warmup.frames, 10);
        return {
          case_id: entry.caseId,
          run,
          fps: result.framesPerSecond,
          elapsed_ms: result.elapsedMs,
          frames: result.frames,
          completion_interval_ms: distribution(result.frameCompletionIntervalsMs),
          plan_wall_ms: distribution(result.planWallLatenciesMs),
        };
      });
      report.measurement_scope =
        "Prepared before actual native admission through durable completion; includes all plan capture, admission, rendering, encoding, spooling, audio mixing and mux work. Loading, device/encoder qualification, audio decoding and ten completed same-device warm-ups excluded. Native mux creation remains inside the interval because whole-job admission precedes publication; no native work is subtracted.";
    }
    report.outputs = [];
    for (const [index, entry] of raw.cases.entries()) {
      const expected = join(
        runDirectory,
        "outputs",
        `${index + 1}-full-mp4-run${run}`,
        "output.mp4",
      );
      assert.equal(resolve(entry.output.outputPath), resolve(expected));
      assert.equal((await stat(expected)).size, entry.output.ffprobe.bytes);
      assert.equal(await hashFile(expected), entry.output.ffprobe.sha256);
      report.outputs.push({
        path: relative(root, expected).replaceAll("\\", "/"),
        sha256: entry.output.ffprobe.sha256,
        bytes: entry.output.ffprobe.bytes,
      });
    }
    report.host = raw.host;
    await retained?.assertStable();
    await native?.assertUnchanged();
    for (const entry of Object.values(report.binaries))
      assert.equal(await hashFile(join(root, entry.path)), entry.sha256);
    const after = await prepareWorkloads(root, environment);
    assert.deepEqual(
      after.map(({ caseHash, inputs }) => ({ caseHash, inputs })),
      workloads.map(({ caseHash, inputs }) => ({ caseHash, inputs })),
    );
    report.hardware_after = await capturePerformanceHardware(root);
    const conditions = ({ capturedAt: _time, ...value }) => value;
    assert.deepEqual(conditions(report.hardware_after), conditions(report.hardware));
    report.source_after = await sourceProvenance(root);
    assert.equal(report.source_after.source_sha256, report.source.source_sha256);
    for (const artifact of report.outputs)
      assert.equal(await hashFile(join(root, artifact.path)), artifact.sha256);
    report.status = "passed";
    report.scope =
      "Single export observation only; timing equivalence, paired coverage, repeated measurements and G5 are still required";
  } catch (error) {
    report.error = error.stack ?? String(error);
  } finally {
    await server?.close();
  }
  report.finished_at = new Date().toISOString();
  await writeAtomicJson(join(output, "report.json"), report);
  return report;
}
