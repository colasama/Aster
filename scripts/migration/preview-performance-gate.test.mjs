import assert from "node:assert/strict";
import test from "node:test";
import {
  aggregatePreviewRounds,
  comparePreviewThroughput,
  previewDistribution,
  previewScenarioNames,
} from "./preview-performance-gate.mjs";

function samples(scenario, value) {
  scenario.samples = { wallMs: Array(600).fill(value), cpuMs: Array(600).fill(value), gpuMs: [] };
  scenario.wallMs = previewDistribution(scenario.samples.wallMs);
  scenario.cpuMs = previewDistribution(scenario.samples.cpuMs);
  scenario.gpuMs = { minimum: 0, median: 0, p95: 0, p99: 0, maximum: 0 };
}

function pair() {
  const reference = {
    sampleFrames: 600,
    warmupFrames: 10,
    backend: "rdna-3",
    quality: { antiAliasing: "off", memoryBudgetMb: 1024, visualization: "beauty" },
    scenarios: Array.from({ length: 7 }, (_, index) => ({
      name: previewScenarioNames[index],
      width: 1920,
      height: 1080,
      layers: 20,
      effects: 0,
      workloadSha256: String(index).repeat(64),
      samples: { wallMs: Array(600).fill(30), cpuMs: Array(600).fill(30), gpuMs: [] },
      wallMs: previewDistribution(Array(600).fill(30)),
      cpuMs: previewDistribution(Array(600).fill(30)),
      gpuMs: { minimum: 0, median: 0, p95: 0, p99: 0, maximum: 0 },
    })),
  };
  const native = structuredClone(reference);
  native.backend = "native-preview";
  for (const scenario of native.scenarios) samples(scenario, 25);
  return { reference, native };
}

test("native preview throughput requires every matched workload to improve", () => {
  const { reference, native } = pair();
  assert(comparePreviewThroughput(reference, native).every((result) => result.faster));
  samples(native.scenarios[6], 30);
  assert.equal(comparePreviewThroughput(reference, native)[6].faster, false);
  samples(native.scenarios[6], 31);
  assert.equal(comparePreviewThroughput(reference, native)[6].faster, false);
});

test("preview comparison refuses unlike quality, scenario identity, incomplete or nonfinite samples", () => {
  for (const mutate of [
    (native) => native.scenarios[0].samples.cpuMs.pop(),
    (native) => native.scenarios[0].samples.gpuMs.push(1),
    (native) => {
      native.scenarios[0].gpuMs.median = 1;
    },
    (native) => {
      native.quality.memoryBudgetMb = 2048;
    },
    (native) => {
      native.scenarios[0].workloadSha256 = "f".repeat(64);
    },
    (native) => {
      native.sampleFrames = 8;
    },
    (native) => {
      native.scenarios.pop();
    },
    (native) => {
      native.scenarios[0].wallMs.p95 = NaN;
    },
    (native) => {
      native.scenarios[0].samples.wallMs.pop();
    },
    (native) => {
      native.scenarios[0].samples.wallMs[0] = Infinity;
    },
    (native) => {
      native.scenarios[0].wallMs.median = 1;
    },
  ]) {
    const { reference, native } = pair();
    mutate(native);
    assert.throws(() => comparePreviewThroughput(reference, native));
  }
});

test("matching duplicate scenarios cannot replace a required workload", () => {
  const { reference, native } = pair();
  reference.scenarios[6] = structuredClone(reference.scenarios[5]);
  native.scenarios[6] = structuredClone(native.scenarios[5]);
  assert.throws(() => comparePreviewThroughput(reference, native));
});

test("preview acceptance uses three run medians and rejects a changed workload between rounds", () => {
  const { reference, native } = pair();
  const first = comparePreviewThroughput(reference, native);
  assert.throws(() => aggregatePreviewRounds([first]));
  samples(native.scenarios[6], 40);
  const slower = comparePreviewThroughput(reference, native);
  const rounds = [first, slower, structuredClone(slower)];
  const result = aggregatePreviewRounds(rounds);
  assert(result[0].faster);
  assert.equal(result[6].faster, false);
  rounds[2][0].workload_sha256 = "f".repeat(64);
  assert.throws(() => aggregatePreviewRounds(rounds));
});
