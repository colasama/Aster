import assert from "node:assert/strict";
import test from "node:test";
import { validatePreviewLatency } from "./preview-latency-audit.mjs";

function fixture() {
  return {
    status: "passed",
    scope: "timeline-input-to-compositor-presentation",
    observer: "serial-compositor-copy-v1",
    timing: "main-process monotonic input dispatch to matching compositor-copy callback",
    warmup: 10,
    focus_readiness: ["geometry", "calibration-0", "calibration-1", "measurement"].map((phase) => ({
      phase,
      attempt: 1,
      focused: true,
      document_focused: true,
    })),
    geometry: { quality: { antiAliasing: "off", memoryBudgetMb: "1024", frameCacheBudgetMb: "0" } },
    references: [24, 26].map((time, index) => ({
      time,
      composition_id: "owner",
      image_sha256: String(index).repeat(64),
    })),
    samples: Array.from({ length: 600 }, (_, index) => ({
      address: index % 2,
      input_ms: index * 10,
      capture_started_ms: index * 10 + 1,
      capture_attempts: 1,
      presentation_ms: index * 10 + 2,
      latency_ms: 2,
      image_sha256: String(index % 2).repeat(64),
    })),
  };
}

test("latency acceptance derives p95 from complete independently presented frame samples", () => {
  assert.equal(validatePreviewLatency(fixture(), "owner").p95, 2);
});

test("latency rejects missing, stale, overlapping, relabeled or unmatched presentation evidence", () => {
  for (const mutate of [
    (value) => {
      value.observer = "frame-subscription";
    },
    (value) => {
      value.timing = "renderer-completion";
    },
    (value) => {
      delete value.samples[0].capture_started_ms;
    },
    (value) => {
      value.samples[0].capture_started_ms = -1;
    },
    (value) => {
      value.samples[0].capture_started_ms = 3;
    },
    (value) => {
      value.samples[0].capture_attempts = 0;
    },
    (value) => value.focus_readiness.pop(),
    (value) => value.focus_readiness.push(value.focus_readiness[3]),
    (value) => {
      value.focus_readiness[2].document_focused = false;
    },
    (value) => value.samples.pop(),
    (value) => {
      value.samples[0].latency_ms = 1;
    },
    (value) => {
      value.samples[1].input_ms = 1;
    },
    (value) => {
      value.samples[0].image_sha256 = "f".repeat(64);
    },
    (value) => {
      value.samples[0].address = 1;
    },
    (value) => {
      value.samples[0].presentation_ms = Infinity;
    },
    (value) => {
      value.references[0].time = 23.999;
    },
    (value) => {
      value.references[0].composition_id = "different";
    },
    (value) => {
      value.references[1].image_sha256 = value.references[0].image_sha256;
    },
    (value) => {
      value.geometry.quality.frameCacheBudgetMb = "512";
    },
    (value) => {
      value.scope = "renderer-completion";
    },
  ]) {
    const value = fixture();
    mutate(value);
    assert.throws(() => validatePreviewLatency(value, "owner"));
  }
});
