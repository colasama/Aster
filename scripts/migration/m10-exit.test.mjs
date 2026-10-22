import assert from "node:assert/strict";
import test from "node:test";
import { assertM10Routing } from "./m10-coverage.mjs";
import { bindM10Gates } from "./m10-gates.mjs";
import { assertM10Layout, assertM10Pixel } from "./m10-pixels.mjs";

test("native text admission binds physical faces, request time and every glyph metric", () => {
  const fonts = [{ family: "Test", face: { sha256: Array(32).fill(1), index: 0 }, variations: [] }],
    request = { composition: "root", layer: "text", source_time: 0.5, resolution_scale: 1 };
  const layout = {
      per_glyph_observed: true,
      bounds_exact: true,
      line_breaks_exact: true,
      native_recipe_admitted: true,
      request,
      fonts,
      deltas: Object.fromEntries(
        [
          "advance",
          "baseline",
          "transform",
          "cluster_advance",
          "cluster_position",
          "glyph_advance",
          "glyph_position",
          "glyph_baseline",
        ].map((k) => [k, 0]),
      ),
    },
    capability = { stage: "native-glyph", fonts, request };
  assertM10Layout(layout, capability);
  for (const change of [
    (v) => {
      v.fonts[0].face.sha256[0] = 2;
    },
    (v) => {
      v.request.source_time = 0.6;
    },
    (v) => {
      v.per_glyph_observed = false;
    },
    (v) => {
      v.line_breaks_exact = false;
    },
    (v) => {
      delete v.deltas.glyph_advance;
    },
    (v) => {
      v.deltas.glyph_position = 0.5001;
    },
    (v) => {
      v.deltas.glyph_baseline = Number.NaN;
    },
  ]) {
    const copy = structuredClone(layout);
    change(copy);
    assert.throws(() => assertM10Layout(copy, capability));
  }
});

test("text exit rejects blanket retention, missing observations and unrecorded fallback reasons", () => {
  const reason = "stroke coverage exceeds isolated raster alpha limit";
  const frame = {
    requests: 2,
    records: 2,
    native: 1,
    retained: 1,
    exact_pixels: 1,
    temporal_samples: 0,
    native_records: [{ rgba_sha256: "a".repeat(64) }],
    reasons: { [reason]: 1, "ordinary outline fill through the platform glyph atlas": 1 },
  };
  const routed = {
    id: "case",
    frames: [frame],
    records: 2,
    native: 1,
    retained: 1,
    exact_pixels: 1,
    temporal_samples: 0,
    reasons: frame.reasons,
  };
  const layout = {
    cases: [{ id: "case", samples: 1, records: 2 }],
    native_text_routing: { status: "passed", full_coverage: true, cases: [routed] },
  };
  const tasks = [
    {
      id: "retained",
      status: "verified_retained",
      route: "M5",
      cases: ["case"],
      reasons: [reason],
    },
  ];
  assert.equal(assertM10Routing(layout, tasks)[0].native, 1);
  for (const change of [
    (v) => {
      v.native_text_routing.cases = [];
    },
    (v) => {
      v.cases[0].records++;
    },
    (v) => {
      v.native_text_routing.cases[0].frames[0].exact_pixels = 0;
    },
    (v) => {
      v.native_text_routing.cases[0].frames[0].reasons.unknown = 1;
    },
    (v) => {
      const c = v.native_text_routing.cases[0];
      for (const i of [c, c.frames[0]]) {
        i.native = 0;
        i.retained = 2;
        i.exact_pixels = 2;
        i.reasons = { [reason]: 2 };
      }
      c.frames[0].native_records = [];
    },
  ]) {
    const copy = structuredClone(layout);
    change(copy);
    assert.throws(() => assertM10Routing(copy, tasks));
  }
  assert.throws(() => assertM10Routing(layout, []));
});

test("accepted reviews cannot hide failed numeric text pixels or a changed image pair", () => {
  const profile = {
    exact: false,
    min_psnr_db: 38,
    min_ssim: 0.99,
    structural: {
      largest_error_component: 256,
      max_abs_signed_bias: 1,
      alpha_changed_fraction: 0.005,
      registration_distance: 0.5,
      ink_edge_delta: 1,
    },
  };
  const catalog = "c".repeat(64),
    reference = "a".repeat(64),
    candidate = "b".repeat(64);
  const result = {
    case_id: "text",
    frame: 0,
    comparison: {
      passed: true,
      profile: {
        name: "perceptual",
        catalog_sha256: catalog,
        limits: { max_abs_channel_error: null, mean_abs_error: null, ...profile },
      },
      reference_rgba_sha256: reference,
      candidate_rgba_sha256: candidate,
      ssim: { mean: 0.999 },
      metrics: { exact: false, psnr: { kind: "finite", db: 60 } },
      structural: {
        largest_error_component: 0,
        signed_bias: [0, 0, 0, 0],
        alpha_changed_fraction: 0,
        ink_bounds: { same_emptiness: true, edge_deltas: [0, 0, 0, 0] },
      },
      registration: { status: "measured", shift: { distance: 0 } },
      isolated: true,
      checks: [
        "psnr",
        "ssim",
        "error_clusters",
        "signed_bias",
        "alpha_coverage",
        "registration",
        "ink_bounds",
      ].map((id) => ({ id, passed: true })),
    },
  };
  const reviews = [
    {
      case_id: "text",
      frame: 0,
      profile: "perceptual",
      verdict: "accepted",
      reference_rgba_sha256: reference,
      candidate_rgba_sha256: candidate,
    },
  ];
  assertM10Pixel(result, reviews, catalog, profile);
  assert.throws(() => assertM10Pixel(result, [], catalog, profile));
  for (const change of [
    (c) => {
      c.candidate_rgba_sha256 = "d".repeat(64);
    },
    (c) => {
      c.ssim.mean = 0.98;
    },
    (c) => {
      c.metrics.psnr.db = 37;
    },
    (c) => {
      c.structural.alpha_changed_fraction = 0.006;
    },
    (c) => {
      c.registration.shift.distance = 0.51;
    },
    (c) => {
      c.structural.ink_bounds.edge_deltas[0] = 2;
    },
    (c) => {
      c.profile.limits.min_psnr_db = 30;
    },
    (c) => {
      c.checks.pop();
    },
  ]) {
    const copy = structuredClone(result);
    change(copy.comparison);
    assert.throws(() => assertM10Pixel(copy, reviews, catalog, profile));
  }
});

test("M10 cannot use quick, partial or duplicate gate claims for exit", async () => {
  const report = {
    milestone: "M10",
    mode: "full",
    run_id: "2026-10-22T00-00-00-000Z-12345678",
    required_gates: ["G0", "G3"],
    gates: [
      { id: "G0", status: "passed" },
      { id: "G3", status: "passed" },
    ],
  };
  for (const change of [
    (r) => {
      r.mode = "quick";
    },
    (r) => {
      r.required_gates = ["G3"];
    },
    (r) => {
      r.gates.push(r.gates[1]);
    },
  ]) {
    const copy = structuredClone(report);
    change(copy);
    await assert.rejects(
      bindM10Gates({ json: () => assert.fail("No artifacts should be trusted") }, copy),
    );
  }
});
