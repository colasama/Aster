import assert from "node:assert/strict";
import test from "node:test";
import { validateCurrentStep } from "./m3-pixels.mjs";
import { validateM4Gates } from "./m4-exit.mjs";
import { coreCases } from "./native-core-scope.mjs";
import { nativeEffectCases } from "./native-effect-scope.mjs";
import { staticCommands } from "./static-checks.mjs";

function fixture() {
  const step = {
    status: "passed",
    exit_code: 0,
    started_at: "2026-10-07T00:00:01Z",
    finished_at: "2026-10-07T00:00:02Z",
  };
  const cases = [...coreCases, ...nativeEffectCases];
  const corpus = {
    cases: cases.map((id) => ({
      id,
      frames: [0],
      features: nativeEffectCases.includes(id) ? [`effect:${id}`] : [],
    })),
  };
  const native = {
    id: "G3",
    status: "passed",
    scope: "native-effects-fused-v4",
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
    native_stills: { status: "passed" },
    native_exr: { status: "passed" },
    native_auxiliary_primary: { status: "passed" },
    native_surface_post: { status: "passed", frames: [{}, {}] },
    native_surface_frames: {
      status: "passed",
      required_count: 16,
      frames: Array.from({ length: 16 }, () => ({})),
    },
    native_layer_cache: {
      status: "passed",
      required_count: cases.length + 16,
      exact: (cases.length + 16) * 4,
      frames: Array.from({ length: (cases.length + 16) * 4 }, () => ({})),
      hits: 1,
      bounded_passes: 1,
      saved_pixels: 1,
    },
    native_ssaa_effect_evaluation: {
      status: "passed",
      strategy_enabled: false,
      decision: "rejected",
      frames: Array.from({ length: 4 }, () => ({
        comparison: { passed: false, metrics: { max_abs_channel_error: 12 } },
      })),
    },
  };
  const report = {
    milestone: "M4",
    mode: "full",
    started_at: "2026-10-07T00:00:00Z",
    required_gates: ["G0", "G3"],
    gates: [
      { id: "G0", status: "passed", steps: staticCommands().map(({ id }) => ({ ...step, id })) },
      native,
    ],
  };
  return { report, corpus };
}

test("M4 exit rejects omitted effects, stale checks and unsafe optimization evidence", () => {
  const { report, corpus } = fixture();
  validateM4Gates(report, corpus);
  for (const mutate of [
    (r) => {
      r.mode = "quick";
    },
    (r) => {
      r.gates[0].steps.pop();
    },
    (r) => {
      r.gates[0].steps[0].started_at = "2020-01-01T00:00:00Z";
    },
    (r) => {
      r.gates[1].full_coverage = false;
    },
    (r) => {
      r.gates[1].native_gpu_execution = false;
    },
    (r) => {
      r.gates[1].frames.pop();
    },
    (r) => {
      r.gates[1].frames[0] = r.gates[1].frames[1];
    },
    (r) => {
      r.gates[1].effect_batch.device_reuses = 0;
    },
    (r) => {
      r.gates[1].native_surface_frames.frames.pop();
    },
    (r) => {
      r.gates[1].native_auxiliary_primary.status = "failed";
    },
    (r) => {
      r.gates[1].native_layer_cache.frames.pop();
    },
    (r) => {
      r.gates[1].native_layer_cache.hits = 0;
    },
    (r) => {
      r.gates[1].native_layer_cache.saved_pixels = 0;
    },
    (r) => {
      r.gates[1].native_ssaa_effect_evaluation.strategy_enabled = true;
    },
    (r) => {
      r.gates[1].native_ssaa_effect_evaluation.frames[0].comparison.passed = true;
    },
  ]) {
    const changed = structuredClone(report);
    mutate(changed);
    assert.throws(() => validateM4Gates(changed, corpus));
  }
  corpus.cases.push({ id: "new-effect", frames: [0], features: ["effect:new"] });
  assert.throws(() => validateM4Gates(report, corpus), /scope differs/);
});

test("pixel rejection is distinct from malformed render input or interruption", () => {
  const step = {
    status: "failed",
    exit_code: 1,
    started_at: "2026-10-07T00:00:01Z",
    finished_at: "2026-10-07T00:00:02Z",
  };
  validateCurrentStep(step, "2026-10-07T00:00:00Z", true, 1);
  assert.throws(() =>
    validateCurrentStep({ ...step, exit_code: 2 }, "2026-10-07T00:00:00Z", true, 1),
  );
  assert.throws(() =>
    validateCurrentStep({ ...step, signal: "SIGTERM" }, "2026-10-07T00:00:00Z", true, 1),
  );
});
