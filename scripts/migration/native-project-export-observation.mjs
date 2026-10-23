import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { capturePerformanceHardware } from "../performance/hardware.mjs";
import { loadThroughputBaseline } from "../performance/measurement-audit.mjs";
import { probeOutput } from "../performance/output-session.mjs";
import { prepareWorkloads } from "../performance/workloads.mjs";
import { nativeExportWorkloads } from "./native-export-series.mjs";
import { nativeProjectMeasurement } from "./native-project-export-measurement.mjs";
import { runStep } from "./process.mjs";
import { writeAtomicJson } from "./report.mjs";
import { hashFile, sourceProvenance } from "./source.mjs";

/** Observe the actual authored-project export path; paired comparison and quality remain separate. */
export async function runNativeProjectExportObservation(
  context,
  prepared,
  { cases = nativeExportWorkloads, smoke = false, run = 1 } = {},
) {
  const { root, output } = context,
    started = Date.now();
  await mkdir(output, { recursive: true });
  const local = (path) => relative(root, path).replaceAll("\\", "/");
  const report = {
    kind: "native-project-export-observation",
    status: "failed",
    native_export_acceptance: false,
    renderer: "rust-project",
    smoke,
    run,
    raster_cache_bytes: 67108864,
    cases: [],
    measurement_scope:
      "Ten completed RGBA warm-ups on the same native project session, matching retained TS readback warm-up. Export timing starts before audio mixing and includes encoder creation, media admission not already warmed, all project evaluation/rendering, encoding, mux and atomic publication. Initial project loading, audio decode and warm-up are excluded; no work is subtracted. FFprobe and artifact authentication run afterward. Millisecond native monotonic receipts determine FPS; full paired quality-matched acceptance is separate.",
  };
  try {
    assert(Number.isSafeInteger(run) && run > 0);
    assert(
      cases.length &&
        new Set(cases).size === cases.length &&
        cases.every((id) => nativeExportWorkloads.includes(id)),
    );
    report.source = await sourceProvenance(root);
    assert.equal(report.source.source_sha256, prepared.source.source_sha256);
    await prepared.assertUnchanged();
    const workloads = await prepareWorkloads(root, context.env),
      pinned = await loadThroughputBaseline(root);
    const selected = cases.map((id) => workloads.find((w) => w.case.id === id));
    assert(selected.every((w) => w && !w.unavailable));
    for (const workload of selected)
      assert.deepEqual(workload.inputs, pinned.cases.get(workload.case.id));
    report.workload_baseline = {
      path: "benchmarks/results/migration-baseline.json",
      sha256: pinned.sha256,
    };
    report.hardware = await capturePerformanceHardware(root);
    assert.equal(report.hardware.runConditions.baselineEligible, true);
    report.execution_artifacts = prepared.execution.snapshot;
    report.binaries = prepared.binaries;
    for (const workload of selected) {
      const id = workload.case.id,
        request = join(output, `${id}.request.json`),
        destination = join(output, `${id}.mp4`);
      const start = Math.min(...workload.frames),
        end = smoke
          ? Math.min(start + 10, Math.max(...workload.frames) + 1)
          : Math.max(...workload.frames) + 1;
      const scale = workload.case.aa === "ssaa4x" ? 4 : workload.case.aa === "ssaa2x" ? 2 : 1;
      await writeAtomicJson(request, {
        settings: {
          resources: {
            visualization: "beauty",
            locale: "en-US",
            layouts: {},
            surface: {
              revision: 1,
              maxTextureDimension: 16384,
              memoryBudgetMb: 512,
              renderScale: scale,
            },
            maximumRasterDimension: 8192,
            maximumRasterPixels: 67108864,
          },
          selectedLayerId: null,
          shadowMapSize: 1024,
        },
        plugins: (workload.case.plugins ?? []).map((p) => join(root, p, "plugin.toml")),
        rasterProvider: { ...prepared.rasterProvider, cacheBytes: report.raster_cache_bytes },
      });
      const requestHash = await hashFile(request);
      const step = await runStep(
        {
          id,
          file: prepared.binary,
          args: [
            "export",
            "--project",
            workload.projectPath,
            "--composition",
            workload.case.composition,
            "--request",
            request,
            "--out",
            destination,
            "--start-frame",
            String(start),
            "--frames",
            String(end - start),
            "--width",
            String(workload.case.size.width),
            "--height",
            String(workload.case.size.height),
            "--fps-numerator",
            String(workload.frameRate.numerator),
            "--fps-denominator",
            String(workload.frameRate.denominator),
            "--aa",
            workload.case.aa,
            "--bitrate",
            "20000000",
            "--benchmark-warmup-frames",
            "10",
            "--ffmpeg",
            join(root, "build/ffmpeg/ffmpeg.exe"),
            "--ffprobe",
            join(root, "build/ffmpeg/ffprobe.exe"),
            "--dxcompiler",
            join(root, "node_modules/electron/dist/dxcompiler.dll"),
          ],
          timeout_ms: 900000,
        },
        context,
      );
      assert.equal(step.status, "passed", `${id} export failed`);
      const rows = (await readFile(join(root, step.log), "utf8"))
        .split(/\r?\n/)
        .filter((l) => l.startsWith("{"))
        .map(JSON.parse);
      const measurement = nativeProjectMeasurement(rows, workload, { smoke }),
        receipt = rows.at(-1);
      const probe = await probeOutput(join(root, "build/ffmpeg/ffprobe.exe"), destination, {
        width: workload.case.size.width,
        height: workload.case.size.height,
        frameCount: end - start,
        frameRateNumerator: workload.frameRate.numerator,
        frameRateDenominator: workload.frameRate.denominator,
        ...(receipt.report.audio_frames ? { audio: { sampleRate: 48000, channels: 2 } } : {}),
      });
      assert.equal(probe.bytes, receipt.report.output_bytes);
      assert.equal(await hashFile(request), requestHash);
      report.cases.push({
        id,
        inputs: workload.inputs,
        case_hash: workload.caseHash,
        measurement,
        request: { path: local(request), sha256: requestHash },
        step,
        receipt,
        rows,
        probe,
        output: { path: local(destination), sha256: probe.sha256, bytes: probe.bytes },
      });
      context.print?.(`${id}: ${measurement.fps.toFixed(3)} FPS native project observation`);
    }
    const after = await prepareWorkloads(root, context.env);
    for (const workload of selected)
      assert.deepEqual(after.find((w) => w.case.id === workload.case.id)?.inputs, workload.inputs);
    report.hardware_after = await capturePerformanceHardware(root);
    const conditions = ({ capturedAt: _time, ...value }) => value;
    assert.deepEqual(conditions(report.hardware), conditions(report.hardware_after));
    for (const entry of report.cases)
      assert.equal(await hashFile(join(root, entry.output.path)), entry.output.sha256);
    await prepared.assertUnchanged();
    report.source_after = await sourceProvenance(root);
    assert.equal(report.source_after.source_sha256, report.source.source_sha256);
    report.source_unchanged = true;
    report.status = "passed";
  } catch (error) {
    report.error = error.stack ?? String(error);
  }
  report.duration_ms = Date.now() - started;
  await writeAtomicJson(join(output, "report.json"), report);
  return report;
}
