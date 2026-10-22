import assert from "node:assert/strict";
import { validSha } from "./m0-evidence.mjs";

/** Bind actual production admission to per-glyph layout and independently reviewed GPU pixels. */
export async function auditM10Native(reader, preparation, session, ledger, routing = null) {
  assert.equal(preparation?.status, "passed");
  assert.equal(session?.status, "passed");
  assert.equal(session.native_text_acceptance, true);
  assert.equal(session.capture_replay?.status, "passed");
  assert.equal(preparation.step.status, "passed");
  assert.equal(session.step.status, "passed");
  assert.equal(preparation.step.exit_code, 0);
  assert.equal(session.step.exit_code, 0);
  const input = await reader.json(session.input.path, session.input.sha256);
  assert.equal(
    preparation.cases.length,
    1,
    "Every admitted project needs its own production session",
  );
  const entry = preparation.cases[0];
  assert.equal(entry.project_sha256, input.project_sha256);
  assert.equal(entry.requests, input.samples.length);
  assert.equal(session.samples.length, entry.requests);
  assert.equal(preparation.comparisons.length, entry.requests);
  const admitted = routing?.cases.filter((c) => c.native > 0);
  if (admitted) {
    assert.deepEqual(
      admitted.map((c) => c.id),
      [entry.id],
    );
    assert.equal(admitted[0].native, session.samples.length);
  }
  const catalog = await reader.bytes("tests/parity/tolerances.json");
  const profile = JSON.parse(catalog.bytes).profiles.perceptual;
  let reviewed = 0;
  for (const result of session.comparisons) {
    assert.equal(result.step.status, "passed");
    assert.equal(result.step.exit_code, 0);
    const raw = await reader.json(result.evidence);
    assert.deepEqual(raw.comparison, result.comparison);
    assert.equal(raw.context.case_id, result.case_id);
    assertM10Pixel(result, ledger.self_reviews, catalog.sha256, profile);
    if (!result.comparison.metrics.exact) reviewed++;
  }
  const used = new Set();
  for (const [index, sample] of session.samples.entries()) {
    assert.equal(sample.index, index);
    const layout = preparation.comparisons[index];
    assert.equal(layout.sample, index);
    assert.equal(layout.case_id, entry.id);
    assertM10Layout(layout, sample.route.capability);
    assert.deepEqual(sample.sample, input.samples[index]);
    const comparison = session.comparisons.find(
      (c) => c.case_id === "native-production-text-layer" && c.frame === sample.comparison,
    );
    assert(comparison, "Admitted text has no layer pixel comparison");
    used.add(sample.comparison);
    if (admitted) {
      const native = admitted[0].frames
        .flatMap((f) => f.native_records)
        .filter(
          (r) =>
            r.composition === layout.request.composition &&
            r.layer === layout.request.layer &&
            r.time === layout.request.source_time,
        );
      assert(native.length > 0, "Layout sample absent from actual production routing");
      for (const record of native)
        assert.equal(record.rgba_sha256, comparison.comparison.reference_rgba_sha256);
    }
    assert.equal(sample.replay.captured_text_pixels, 1);
    validSha(sample.replay.rgba_sha256);
    validSha(sample.route.frame);
  }
  assert.equal(
    used.size,
    session.comparisons.filter((c) => c.case_id === "native-production-text-layer").length,
  );
  return {
    status: "passed",
    case_id: entry.id,
    samples: session.samples.length,
    comparisons: session.comparisons.length,
    reviewed,
    maxima: preparation.maxima,
  };
}

export function assertM10Layout(layout, capability) {
  assert.equal(layout.per_glyph_observed, true);
  assert.equal(layout.bounds_exact, true);
  assert.equal(layout.line_breaks_exact, true);
  assert.equal(layout.native_recipe_admitted, true);
  assert.equal(capability.stage, "native-glyph");
  assert.deepEqual(layout.request, capability.request);
  assert.deepEqual(
    layout.fonts.map(({ family, face, variations }) => ({ family, face, variations })),
    capability.fonts,
  );
  assert(layout.fonts.length > 0);
  for (const key of [
    "advance",
    "baseline",
    "transform",
    "cluster_advance",
    "cluster_position",
    "glyph_advance",
    "glyph_position",
    "glyph_baseline",
  ]) {
    const value = layout.deltas[key];
    assert(Number.isFinite(value) && value >= 0 && value <= 0.5, `Unqualified text layout: ${key}`);
  }
}

export function assertM10Pixel(result, reviews, catalogSha, profile) {
  const c = result.comparison;
  assert.equal(c.passed, true);
  assert.equal(c.profile.name, "perceptual");
  assert.equal(c.profile.catalog_sha256, catalogSha);
  assert.deepEqual(c.profile.limits, {
    max_abs_channel_error: null,
    mean_abs_error: null,
    ...profile,
  });
  validSha(c.reference_rgba_sha256);
  validSha(c.candidate_rgba_sha256);
  assert(c.ssim.mean >= 0.99 && c.ssim.mean <= 1);
  assert(
    c.metrics.psnr.kind === "infinite" ||
      (Number.isFinite(c.metrics.psnr.db) && c.metrics.psnr.db >= 38),
  );
  assert(c.structural.largest_error_component >= 0 && c.structural.largest_error_component <= 256);
  assert(
    c.structural.signed_bias.length === 4 &&
      c.structural.signed_bias.every((v) => Number.isFinite(v) && Math.abs(v) <= 1),
  );
  assert(c.structural.alpha_changed_fraction >= 0 && c.structural.alpha_changed_fraction <= 0.005);
  assert.equal(c.registration.status, "measured");
  assert(c.registration.shift.distance >= 0 && c.registration.shift.distance <= 0.5);
  const checks = [
    "psnr",
    "ssim",
    "error_clusters",
    "signed_bias",
    "alpha_coverage",
    "registration",
  ];
  if (c.isolated) {
    checks.push("ink_bounds");
    assert.equal(c.structural.ink_bounds.same_emptiness, true);
    assert(
      c.structural.ink_bounds.edge_deltas.length === 4 &&
        c.structural.ink_bounds.edge_deltas.every((v) => Number.isFinite(v) && Math.abs(v) <= 1),
    );
  }
  assert.deepEqual(c.checks.map((v) => v.id).sort(), checks.sort());
  assert(c.checks.every((v) => v.passed));
  if (c.metrics.exact) assert.equal(c.reference_rgba_sha256, c.candidate_rgba_sha256);
  else
    assert(
      reviews.some(
        (r) =>
          r.case_id === result.case_id &&
          r.frame === result.frame &&
          r.profile === "perceptual" &&
          r.verdict === "accepted" &&
          r.reference_rgba_sha256 === c.reference_rgba_sha256 &&
          r.candidate_rgba_sha256 === c.candidate_rgba_sha256,
      ),
      "Native pixel self-review missing",
    );
}
