import assert from "node:assert/strict";
import test from "node:test";
import { validateM5Gates } from "./m5-gates.mjs";
import { coreCases } from "./native-core-scope.mjs";
import { nativeEffectCases } from "./native-effect-scope.mjs";
import { nativeRasterCases } from "./native-raster-batch.mjs";
import { staticCommands } from "./static-checks.mjs";

function fixture() {
  const step = {
    status: "passed",
    exit_code: 0,
    started_at: "2026-10-07T00:00:01Z",
    finished_at: "2026-10-07T00:00:02Z",
  };
  const source = { source_sha256: "a".repeat(64) },
    binary = { sha256: "b".repeat(64) };
  const cases = [...coreCases, ...nativeEffectCases, ...nativeRasterCases];
  const corpus = {
    cases: cases.map((id) => ({
      id,
      frames: [0],
      features: nativeEffectCases.includes(id) ? [`effect:${id}`] : [],
    })),
  };
  const ir = {
    id: "G1",
    status: "passed",
    source,
    source_after: source,
    source_unchanged: true,
    binary,
    renderer_plan_complete: true,
    raster_pixels: {
      status: "passed",
      resources: 3,
      exact_pixels: true,
      exact_bounds: true,
      dependency_eviction: true,
      corrupt_pixels_rejected: true,
      conflicting_generation_rejected: true,
      scope_checked: true,
    },
    resources: {
      checks: [
        "descriptor_content_hash",
        "wrong_hash",
        "input_ownership",
        "idempotent_put",
        "budget_atomicity",
        "atomic_pin",
        "pinned_eviction",
        "missing_resource",
      ],
    },
    temporal_samples: ["full", "transparent", "exact-bits", "enters", "exits"].map((s) => ({
      id: `temporal-${s}`,
      exact_samples: true,
      exact_weights: true,
      exact_exposure: true,
      formats_preserved: true,
    })),
    temporal_passes: ["full", "partial", "transparent", "exact-bits"].map((s) => ({
      id: `temporal-pass-${s}`,
      exact_weights: true,
      ordered_hashes_exact: true,
      supplied_execution: true,
    })),
    frame_bundles: [
      {
        id: "frame-bundle-temporal",
        temporal_passes: 2,
        media_pixels: 4,
        exact_payloads: true,
        exact_dependencies: true,
        missing_rejected: true,
        corrupt_rejected: true,
        rust_count_rejected: true,
      },
    ],
  };
  const native = {
    id: "G3",
    status: "passed",
    scope: "native-rasters-v1",
    binary,
    full_coverage: true,
    milestone_exit_eligible: true,
    native_gpu_execution: true,
    cases,
    frames: cases.map((case_id) => ({ case_id, frame: 0 })),
    required_count: cases.length,
    build: step,
    image_cache: step,
    effect_batch: {
      step,
      frames: nativeEffectCases.length,
      device_reuses: nativeEffectCases.length - 1,
    },
    raster_batch: {
      step,
      frames: nativeRasterCases.length,
      device_reuses: nativeRasterCases.length - 1,
    },
    native_stills: { status: "passed" },
    native_exr: { status: "passed" },
    native_surface_post: { status: "passed" },
    native_auxiliary_primary: { status: "passed" },
    native_surface_frames: {
      status: "passed",
      required_count: 16,
      frames: Array.from({ length: 16 }, () => ({})),
    },
    native_ssaa_effect_evaluation: {
      status: "passed",
      strategy_enabled: false,
      decision: "rejected",
    },
    native_layer_cache: {
      status: "passed",
      required_count: cases.length + 16,
      exact: (cases.length + 16) * 4,
      frames: Array.from({ length: (cases.length + 16) * 4 }, () => ({})),
    },
    native_temporal_text: { status: "passed", frames: [{}, {}, {}, {}] },
    native_temporal_frames: { status: "passed", frames: [{}, {}] },
    native_motion_frames: { status: "passed", frames: [{}, {}, {}, {}, {}, {}] },
  };
  return {
    corpus,
    report: {
      milestone: "M5",
      mode: "full",
      source,
      started_at: "2026-10-07T00:00:00Z",
      required_gates: ["G0", "G1", "G3"],
      gates: [
        { id: "G0", status: "passed", steps: staticCommands().map(({ id }) => ({ ...step, id })) },
        ir,
        native,
      ],
    },
  };
}

test("M5 rejects missing raster coverage, stale IR and incomplete temporal evidence", () => {
  const { report, corpus } = fixture();
  validateM5Gates(report, corpus);
  for (const mutate of [
    (r) => {
      r.mode = "quick";
    },
    (r) => {
      r.gates[0].steps.pop();
    },
    (r) => {
      r.gates[0].steps[0].started_at = "2000-01-01T00:00:00Z";
    },
    (r) => {
      r.gates[1].source_after = { source_sha256: "c".repeat(64) };
    },
    (r) => {
      r.gates[1].raster_pixels.dependency_eviction = false;
    },
    (r) => {
      r.gates[1].raster_pixels.conflicting_generation_rejected = false;
    },
    (r) => {
      r.gates[1].resources.checks.pop();
    },
    (r) => {
      r.gates[1].temporal_samples.pop();
    },
    (r) => {
      r.gates[1].temporal_passes[0].ordered_hashes_exact = false;
    },
    (r) => {
      r.gates[1].frame_bundles[0].temporal_passes = 0;
    },
    (r) => {
      r.gates[2].full_coverage = false;
    },
    (r) => {
      r.gates[2].frames.pop();
    },
    (r) => {
      r.gates[2].frames[0] = r.gates[2].frames[1];
    },
    (r) => {
      r.gates[2].raster_batch.device_reuses = 0;
    },
    (r) => {
      r.gates[2].native_temporal_text.frames.pop();
    },
    (r) => {
      r.gates[2].native_temporal_frames.status = "failed";
    },
    (r) => {
      r.gates[2].native_motion_frames.frames.pop();
    },
    (r) => {
      r.gates[2].native_layer_cache.exact--;
    },
    (r) => {
      r.gates[2].native_gpu_execution = false;
    },
  ]) {
    const altered = structuredClone(report);
    mutate(altered);
    assert.throws(() => validateM5Gates(altered, corpus));
  }
});
