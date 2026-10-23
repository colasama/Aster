import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { auditM10Native } from "./m10-pixels.mjs";

/** A previously reviewed glyph pair is an immutable input, never a new pixel tolerance. */
export async function loadQualifiedProjectText(reader) {
  const ledger = await reader.json("docs/migration/rust-renderer-progress.json");
  const milestone = ledger.milestones.find((m) => m.id === "M10");
  assert.equal(milestone.status, "done");
  const task = milestone.tasks.find((t) => t.id === "M10-T8");
  assert.equal(task.status, "done");
  assert.equal(task.exit_audit.native_text_acceptance, true);
  const pin = task.exit_audit.gate_reports.G3;
  const gate = await reader.json(pin.path, pin.sha256);
  assert.equal(gate.status, "passed");
  const layout = gate.native_text_layout;
  const session = layout.native_project_session;
  await auditM10Native(
    reader,
    layout.native_admitted_layout,
    session,
    ledger,
    layout.native_text_routing,
  );
  const input = await reader.json(session.input.path, session.input.sha256);
  const admitted = layout.native_admitted_layout.cases[0];
  const coverage = layout.cases.find((c) => c.id === admitted.id);
  assert(coverage);
  const ordinary = await reader.json(coverage.ordinary.path, coverage.ordinary.sha256);
  const observed = ordinary.cases.find((c) => c.id === admitted.id);
  assert.equal(observed.project_sha256, coverage.project_sha256);
  assert.equal(input.project_sha256, coverage.project_sha256);
  const pairs = [];
  for (const [index, sample] of session.samples.entries()) {
    const observation = observed.observations[index];
    const path = join(dirname(coverage.ordinary.path), admitted.id, observation.path).replaceAll(
      "\\",
      "/",
    );
    const record = await reader.json(path, observation.sha256);
    assert.equal(
      record.records.length,
      1,
      "Only independently qualified single glyph layers apply",
    );
    const text = record.records[0];
    const comparison = session.comparisons.find(
      (c) => c.case_id === "native-production-text-layer" && c.frame === sample.comparison,
    );
    assert(comparison);
    assert.equal(text.rgba_sha256, comparison.comparison.reference_rgba_sha256);
    assert.equal(text.retained_reference.rgba_sha256, text.rgba_sha256);
    assert.equal(text.temporal, false);
    assert.equal(text.composition, sample.route.capability.request.composition);
    assert.equal(text.layer, sample.route.capability.request.layer);
    assert.equal(text.local_time, sample.route.capability.request.source_time);
    pairs.push({
      case_id: admitted.id,
      authored_sha256: coverage.project_sha256,
      instance_id: sample.route.instance_id,
      capability: sample.route.capability,
      width: text.width,
      height: text.height,
      bounds: text.bounds,
      reference_gpu_sha256: text.retained_reference.gpu_rgba_sha256,
      candidate_gpu_sha256: comparison.comparison.candidate_rgba_sha256,
      observation: { path, sha256: observation.sha256 },
      comparison: comparison.evidence,
    });
  }
  return { gate: pin, pairs };
}

export function matchQualifiedText(qualification, candidate) {
  const pair = qualification.pairs.find(
    (p) =>
      p.case_id === candidate.case_id &&
      p.authored_sha256 === candidate.authored_sha256 &&
      p.instance_id === candidate.route.instance_id &&
      p.reference_gpu_sha256 === candidate.reference_gpu_sha256 &&
      p.candidate_gpu_sha256 === candidate.candidate_gpu_sha256 &&
      p.width === candidate.width &&
      p.height === candidate.height,
  );
  assert(pair, "Native text pixels have no exact authenticated M10 pair");
  const actual = candidate.route.capability;
  const accepted = pair.capability;
  assert.equal(actual.stage, "native-glyph");
  assert.equal(actual.project_sha256, accepted.project_sha256);
  assert.equal(actual.reason, accepted.reason);
  assert.deepEqual(actual.fonts, accepted.fonts);
  // Raster identity is qualified by exact pixels; time remains in the unchanged evaluator plan.
  for (const key of ["composition", "layer", "resolution_scale", "locale", "bounds"])
    assert.deepEqual(actual.request[key], accepted.request[key]);
  assert.equal(actual.request.source_time, candidate.time);
  assert(actual.request.maximum_dimension >= Math.max(candidate.width, candidate.height));
  assert.deepEqual(candidate.bounds, [
    pair.bounds.x,
    pair.bounds.y,
    pair.bounds.width,
    pair.bounds.height,
  ]);
  return { gate: qualification.gate, observation: pair.observation, comparison: pair.comparison };
}
