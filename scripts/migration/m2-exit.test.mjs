import assert from "node:assert/strict";
import test from "node:test";
import { validateM2Gates } from "./m2-exit.mjs";
import { staticCommands } from "./static-checks.mjs";

function fixture() {
  const source = { source_sha256: "a".repeat(64) };
  const binary = { sha256: "b".repeat(64) };
  const evidence = {
    status: "passed",
    source_unchanged: true,
    source,
    source_after: source,
    started_at: "2026-10-06T00:00:01Z",
  };
  const ir = {
    ...evidence,
    id: "G1",
    binary,
    resources: {
      status: "passed",
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
    media_resources: { dependency_eviction: true },
    raster_pixels: { dependency_eviction: true },
    roundtrips: [{ exact: true }],
    frame_bundles: Array.from({ length: 3 }, () => ({
      exact_payloads: true,
      exact_dependencies: true,
      missing_rejected: true,
      corrupt_rejected: true,
      rust_count_rejected: true,
      capture_admission: {
        exact: true,
        missing_rejected: true,
        execution_change_rejected: true,
        discovery_rejected: true,
        corrupt_rejected: true,
      },
    })),
  };
  const renderer = {
    renderer_source_sha256: "c".repeat(64),
    tree_sha256: source.source_sha256,
    ir_cli_sha256: binary.sha256,
  };
  const gate = {
    status: "passed",
    scope: "full",
    full_coverage: true,
    inputs_unchanged: true,
    frames: [0],
    required_count: 1,
    comparisons: [{ exact: true }],
    reference_binding: { frozen: true },
  };
  const extras = Object.fromEntries(
    [
      "raster_resources",
      "frame_artifacts",
      "temporal_text",
      "encoded_textures",
      "material_draws",
      "lut_draws",
      "root_scenes",
      "generators",
      "precompositions",
      "auxiliary",
      "auxiliary_generators",
      "output_replay",
    ].map((key) => [key, { status: "passed" }]),
  );
  Object.assign(extras.frame_artifacts, { exact_rust_roundtrip: true, exact_ts_replay: true });
  const exact = {
    ...evidence,
    ...extras,
    renderer_source: renderer,
    renderer_source_after: renderer,
    build: { status: "passed", exit_code: 0 },
    gate,
  };
  const report = {
    milestone: "M2",
    mode: "full",
    required_gates: ["G0", "G1", "G3"],
    source,
    started_at: "2026-10-06T00:00:00Z",
    gates: [
      {
        id: "G0",
        status: "passed",
        steps: staticCommands().map(({ id }) => ({ id, status: "passed", exit_code: 0 })),
      },
      ir,
      { ...structuredClone(gate), ...structuredClone(extras), id: "G3", source_unchanged: true },
    ],
  };
  return { report, exact, ir };
}

test("M2 requires current full gates and identical source-bound replay evidence", () => {
  const data = fixture();
  assert.equal(validateM2Gates(data.report, data.exact).ir, data.ir);
  for (const mutate of [
    ({ report }) => {
      report.mode = "quick";
    },
    ({ report }) => {
      report.gates[0].steps.pop();
    },
    ({ report }) => {
      report.gates[0].steps[0].exit_code = 1;
    },
    ({ exact }) => {
      exact.started_at = "2026-10-05T00:00:00Z";
    },
    ({ exact }) => {
      exact.source = { source_sha256: "d".repeat(64) };
    },
    ({ ir }) => {
      ir.binary.sha256 = "d".repeat(64);
    },
    ({ ir }) => {
      ir.resources.checks = ir.resources.checks.filter((x) => x !== "pinned_eviction");
    },
    ({ ir }) => {
      ir.frame_bundles[0].capture_admission.discovery_rejected = false;
    },
    ({ exact }) => {
      exact.frame_artifacts.exact_ts_replay = false;
    },
    ({ report }) => {
      report.gates[2].frame_artifacts.exact_rust_roundtrip = false;
    },
    ({ exact }) => {
      delete exact.temporal_text;
    },
    ({ exact }) => {
      exact.gate.full_coverage = false;
    },
  ]) {
    const changed = fixture();
    mutate(changed);
    assert.throws(() => validateM2Gates(changed.report, changed.exact));
  }
});
