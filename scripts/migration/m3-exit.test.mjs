import assert from "node:assert/strict";
import test from "node:test";
import { validateM3Gates } from "./m3-exit.mjs";
import { coreCases, coreCorpus } from "./native-core-scope.mjs";
import { staticCommands } from "./static-checks.mjs";

function fixture() {
  const source = { source_sha256: "a".repeat(64) },
    binary = { sha256: "b".repeat(64) };
  const step = {
    status: "passed",
    exit_code: 0,
    started_at: "2026-10-06T00:00:01Z",
    finished_at: "2026-10-06T00:00:02Z",
  };
  const corpus = { cases: coreCases.map((id) => ({ id, features: [], frames: [0] })) };
  const report = {
    milestone: "M3",
    mode: "full",
    source,
    started_at: "2026-10-06T00:00:00Z",
    required_gates: ["G0", "G1", "G3"],
    gates: [
      { id: "G0", status: "passed", steps: staticCommands().map(({ id }) => ({ ...step, id })) },
      {
        id: "G1",
        status: "passed",
        source_unchanged: true,
        source,
        source_after: source,
        started_at: step.started_at,
        renderer_plan_complete: true,
        binary,
      },
      {
        id: "G3",
        status: "passed",
        scope: "native-core-v5",
        full_coverage: true,
        milestone_exit_eligible: true,
        native_gpu_execution: true,
        binary,
        cases: [...coreCases],
        required_count: coreCases.length,
        frames: coreCases.map((case_id) => ({
          case_id,
          frame: 0,
          receipt: { surface_cache: { allocations: 1, resident_bytes: 12 } },
        })),
        build: { ...step },
        image_cache: { ...step },
        native_stills: { status: "passed" },
        native_exr: {
          status: "passed",
          native_image_decode: true,
          format: "rgba16float",
          reference_boundary: "ts-exr-import",
          ts_pixel_parity: false,
        },
      },
    ],
  };
  return { report, corpus };
}

test("M3 exit rejects partial, stale, substituted or non-native gate evidence", () => {
  const { report, corpus } = fixture();
  validateM3Gates(report, corpus);
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
      r.gates[1].source_after = { source_sha256: "c".repeat(64) };
    },
    (r) => {
      r.gates[2].binary = { sha256: "c".repeat(64) };
    },
    (r) => {
      r.gates[2].native_gpu_execution = false;
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
      r.gates[2].frames.find(
        (f) => f.case_id === "nested-precompositions",
      ).receipt.surface_cache.allocations = 0;
    },
    (r) => {
      r.gates[2].native_exr.ts_pixel_parity = true;
    },
  ]) {
    const changed = structuredClone(report);
    mutate(changed);
    assert.throws(() => validateM3Gates(changed, corpus));
  }
});

test("core corpus cannot silently omit newly cataloged blend, AA, shape or mask cases", () => {
  for (const feature of ["blend:new", "aa:new", "shape:new", "mask:new"]) {
    const { corpus } = fixture();
    corpus.cases.push({ id: "additional", features: [feature], frames: [0] });
    assert.throws(() => coreCorpus(corpus), /Uncovered core feature/);
  }
});
