import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { captureAssignments } from "../parity/provenance.mjs";
import { capturePerformanceHardware } from "../performance/hardware.mjs";
import { auditPreviewLatency } from "./preview-latency-audit.mjs";
import { runStep } from "./process.mjs";
import { writeAtomicJson } from "./report.mjs";
import { hashFile, sourceProvenance } from "./source.mjs";

export function previewDistribution(samples) {
  assert(Array.isArray(samples) && samples.length > 0);
  assert(samples.every((value) => Number.isFinite(value) && value > 0));
  const values = [...samples].sort((a, b) => a - b);
  const percentile = (position) => {
    const index = position * (values.length - 1),
      lower = Math.floor(index),
      upper = Math.ceil(index);
    const weight = index - lower;
    return values[lower] * (1 - weight) + values[upper] * weight;
  };
  return {
    minimum: values[0],
    median: percentile(0.5),
    p95: percentile(0.95),
    p99: percentile(0.99),
    maximum: values.at(-1),
  };
}

export function comparePreviewThroughput(ts, native) {
  assert.equal(ts.sampleFrames, 600);
  assert.equal(native.sampleFrames, 600);
  assert.equal(ts.warmupFrames, 10);
  assert.equal(native.warmupFrames, 10);
  assert.equal(native.backend, "native-preview");
  assert.notEqual(ts.backend, "native-preview");
  assert.notEqual(ts.backend, "cpu", "Canvas fallback cannot qualify the TS GPU baseline");
  assert(ts.quality && native.quality);
  assert.deepEqual(native.quality, ts.quality);
  assert.equal(native.compositionId, ts.compositionId);
  assert.equal(ts.quality.memoryBudgetMb, 1024);
  assert.equal(ts.quality.visualization, "beauty");
  assert.equal(ts.scenarios.length, 7);
  assert.deepEqual(
    native.scenarios.map((s) => s.name),
    ts.scenarios.map((s) => s.name),
  );
  return ts.scenarios.map((reference, index) => {
    const candidate = native.scenarios[index];
    for (const key of ["width", "height", "layers", "effects", "workloadSha256"])
      assert.deepEqual(candidate[key], reference[key], `Preview workload differs: ${key}`);
    assert(/^[a-f0-9]{64}$/.test(reference.workloadSha256));
    for (const scenario of [reference, candidate]) {
      assert.equal(scenario.samples?.wallMs?.length, 600, "Complete raw wall samples required");
      assert.deepEqual(scenario.wallMs, previewDistribution(scenario.samples.wallMs));
    }
    return {
      name: reference.name,
      workload_sha256: reference.workloadSha256,
      ts_median_ms: reference.wallMs.median,
      native_median_ms: candidate.wallMs.median,
      ts_median_fps: 1000 / reference.wallMs.median,
      native_median_fps: 1000 / candidate.wallMs.median,
      faster: candidate.wallMs.median < reference.wallMs.median,
    };
  });
}

export function aggregatePreviewRounds(rounds) {
  assert.equal(rounds.length, 3, "Three measured preview pairs are required");
  const identity = rounds[0].map(({ name, workload_sha256 }) => ({ name, workload_sha256 }));
  for (const round of rounds)
    assert.deepEqual(
      round.map(({ name, workload_sha256 }) => ({ name, workload_sha256 })),
      identity,
    );
  return identity.map((item, index) => {
    const ts = rounds.map((round) => round[index].ts_median_fps);
    const native = rounds.map((round) => round[index].native_median_fps);
    const tsMedian = previewDistribution(ts).median;
    const nativeMedian = previewDistribution(native).median;
    return {
      ...item,
      ts_run_median_fps: ts,
      native_run_median_fps: native,
      ts_median_fps: tsMedian,
      native_median_fps: nativeMedian,
      faster: nativeMedian > tsMedian,
    };
  });
}

/** Throughput evidence remains incomplete until the independent editor-input latency check passes. */
export async function runPreviewPerformanceGate(context, execute = runStep) {
  const { root, output } = context;
  const local = (path) => relative(root, path).replaceAll("\\", "/");
  const report = {
    id: "G4",
    status: "failed",
    scope: "paired-editor-preview",
    native_preview_acceptance: false,
    steps: [],
    arms: [],
    rounds: [],
  };
  const started = Date.now();
  await mkdir(output, { recursive: true });
  try {
    report.source = await sourceProvenance(root);
    if (context.source) assert.equal(context.source.source_sha256, report.source.source_sha256);
    assert(context.env.ASTER_PERF_PROJECT, "Owner project is required");
    const corpus = JSON.parse(await readFile(join(root, "tests/parity/corpus.json")));
    const owner = corpus.cases.find((c) => c.id === "owner-main");
    assert(owner);
    const inputs = await captureAssignments(root, [owner], context.env);
    assert(!inputs[0].unavailable, inputs[0].unavailable);
    report.owner = inputs[0].inputs;
    report.hardware = await capturePerformanceHardware(root);
    assert.equal(
      report.hardware.runConditions.baselineEligible,
      true,
      "Current hardware or AC power is not qualified",
    );
    for (const command of [
      {
        id: "preview-perf-bridge-build",
        file: "cargo",
        args: ["build", "-p", "aster-desktop-bridge"],
      },
      { id: "preview-perf-web-build", file: "pnpm", args: ["exec", "vite", "build"] },
      {
        id: "preview-perf-raster-build",
        file: process.execPath,
        args: ["scripts/build-native-raster.mjs"],
      },
      { id: "preview-perf-electron-build", file: "pnpm", args: ["electron:compile"] },
    ]) {
      const step = await execute(command, context);
      report.steps.push(step);
      assert.equal(step.status, "passed");
    }
    report.binaries = await Promise.all(
      [
        "release/aster-render-cli.exe",
        "release/aster-desktop-bridge.exe",
        "debug/aster-desktop-bridge.exe",
      ].map(async (name) => {
        const path = join(root, "target", name);
        return { path: local(path), sha256: await hashFile(path) };
      }),
    );
    for (let round = 0; round < 3; round++) {
      const arms = [];
      for (const engine of round % 2 === 0 ? ["ts", "native"] : ["native", "ts"]) {
        const directory = join(output, `round-${round + 1}`, engine);
        const step = await execute(
          {
            id: `preview-perf-${round + 1}-${engine}`,
            file: process.execPath,
            args: ["scripts/migration/preview-editor-capture.mjs", directory],
            timeout_ms: 1900000,
            env: {
              ASTER_PREVIEW_ENGINE: engine,
              ASTER_PREVIEW_BENCHMARK_SAMPLES: "600",
              ASTER_PREVIEW_BENCHMARK_ONLY: "1",
              ASTER_PREVIEW_BENCHMARK_SCENARIO: "",
              ASTER_PREVIEW_BENCHMARK_COMPOSITION: owner.composition,
              ASTER_PREVIEW_OWNER_PROJECT: context.env.ASTER_PERF_PROJECT,
              ASTER_PREVIEW_LATENCY_SAMPLES: "600",
            },
          },
          context,
        );
        report.steps.push(step);
        const path = join(directory, "report.json");
        const witness = JSON.parse(await readFile(path));
        const processReport = JSON.parse(await readFile(join(directory, "process.json")));
        assert.equal(step.status, "passed", witness.error);
        assert.equal(witness.status, "passed", witness.error);
        assert.equal(processReport.status, "passed", processReport.error);
        assert.equal(witness.engine, engine);
        assert.equal(witness.benchmark.compositionId, owner.composition);
        assert(witness.host?.cacheIdentity?.devices?.some((device) => device.active));
        if (engine === "native") {
          const adapters = witness.native_calls
            .filter((call) => call.ready?.adapter)
            .map((call) => call.ready.adapter);
          assert(adapters.length > 0);
          for (const adapter of adapters) {
            assert.equal(adapter.backend, "Dx12");
            assert(
              witness.host.cacheIdentity.devices.some(
                (device) =>
                  device.active &&
                  device.vendorId === adapter.vendor &&
                  device.deviceId === adapter.device,
              ),
              "Native renderer did not use the active Electron adapter",
            );
          }
        } else assert.equal(witness.native_calls.length, 0);
        const arm = {
          round: round + 1,
          engine,
          evidence: { path: local(path), sha256: await hashFile(path) },
          host: witness.host.cacheIdentity,
          benchmark: witness.benchmark,
          latency: witness.latency,
        };
        report.arms.push(arm);
        arms.push(arm);
      }
      assert.deepEqual(arms[0].host, arms[1].host, "Electron GPU identity changed between arms");
      assert.deepEqual(
        arms[0].host,
        report.arms[0].host,
        "Electron GPU identity changed between rounds",
      );
      for (const arm of arms)
        assert.deepEqual(arm.benchmark.quality, report.arms[0].benchmark.quality);
      report.rounds.push(
        comparePreviewThroughput(
          arms.find((arm) => arm.engine === "ts").benchmark,
          arms.find((arm) => arm.engine === "native").benchmark,
        ),
      );
    }
    report.comparisons = aggregatePreviewRounds(report.rounds);
    report.latency = await auditPreviewLatency(root, report.arms, owner.composition);
    report.hardware_after = await capturePerformanceHardware(root);
    for (const key of [
      "platform",
      "operatingSystem",
      "cpu",
      "memory",
      "graphicsAdapters",
      "displays",
      "power",
    ])
      assert.deepEqual(
        report.hardware_after[key],
        report.hardware[key],
        `Hardware changed: ${key}`,
      );
    assert.deepEqual(await captureAssignments(root, [owner], context.env), inputs);
    for (const binary of report.binaries)
      assert.equal(await hashFile(join(root, binary.path)), binary.sha256);
    report.source_after = await sourceProvenance(root);
    report.source_unchanged = report.source_after.source_sha256 === report.source.source_sha256;
    assert(report.source_unchanged);
    report.throughput_passed = report.comparisons.every((c) => c.faster);
    report.native_preview_acceptance =
      report.throughput_passed && report.latency.status === "passed";
    report.status = report.native_preview_acceptance ? "passed" : "failed";
    if (!report.native_preview_acceptance)
      report.error = report.throughput_passed
        ? report.latency.criterion
        : "Native preview must exceed TS median FPS in every matched scenario";
  } catch (error) {
    report.error = String(error.stack ?? error);
  }
  report.duration_ms = Date.now() - started;
  await writeAtomicJson(join(output, "report.json"), report);
  return report;
}
