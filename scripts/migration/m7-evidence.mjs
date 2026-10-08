import assert from "node:assert/strict";
import { stat } from "node:fs/promises";
import { join, posix, resolve } from "node:path";
import { validateReport } from "../parity/pixel-gate.mjs";
import { reviewStatus } from "../parity/pixel-review.mjs";
import { validateCurrentStep } from "./m3-pixels.mjs";
import { mediaLocal } from "./m6-media.mjs";

export const sceneLocal = (reader, path) => mediaLocal(reader, resolve(reader.root, path));

/** Authenticate the actual invocation and require rejection before output publication. */
export async function auditSceneRejection(reader, step, report, pattern, expectedPlan) {
  validateCurrentStep(step, report.started_at, true);
  assert.equal(
    step.command[0],
    join(reader.root, report.gates.find((g) => g.id === "G3").binary.path),
  );
  const argument = (name) => {
    const index = step.command.indexOf(name);
    assert(index > 0, `Missing rejection argument ${name}`);
    return step.command[index + 1];
  };
  const plan = await reader.bytes(sceneLocal(reader, argument("--plan")));
  if (expectedPlan) assert.equal(plan.sha256, expectedPlan);
  assert.match((await reader.bytes(step.log)).bytes.toString("utf8"), pattern);
  const out = argument("--out");
  assert(sceneLocal(reader, out).startsWith("artifacts/migration/"));
  await assert.rejects(stat(resolve(reader.root, out)), { code: "ENOENT" });
}

/** Reuse the common metric/structural and self-review validators for supplemental frozen images. */
export async function auditSceneComparison(reader, frame, frozen, candidatePath, report, ledger) {
  validateCurrentStep(frame.step, report.started_at);
  assert.equal(
    frame.step.command[0],
    join(reader.root, report.gates.find((g) => g.id === "G3").binary.path),
  );
  const raw = await reader.json(frame.evidence);
  assert.deepEqual(raw.comparison, frame.comparison);
  const reference = await reader.image(frozen.reference.path, frozen.reference.sha256);
  const candidate = await reader.image(sceneLocal(reader, candidatePath), raw.candidate.png_sha256);
  assert.equal(sceneLocal(reader, raw.reference.path), frozen.reference.path);
  assert.equal(sceneLocal(reader, raw.candidate.path), sceneLocal(reader, candidatePath));
  assert.equal(reference.rgba_sha256, frozen.reference.rgba_sha256);
  assert.equal(candidate.rgba_sha256, raw.comparison.candidate_rgba_sha256);
  const catalogFile = await reader.bytes("tests/parity/tolerances.json");
  const inputs = {
    context: { root: reader.root },
    ledger,
    catalog: JSON.parse(catalogFile.bytes.toString("utf8")),
    catalogHash: catalogFile.sha256,
    bytes: (path) => reader.bytes(sceneLocal(reader, path)),
  };
  const entry = {
    case_id: frame.case_id,
    frame: frame.frame,
    profile: "gpu",
    item: { size: { width: frozen.width, height: frozen.height } },
    png_sha256: candidate.png_sha256,
  };
  const limits = inputs.catalog.profiles.gpu;
  const expectedLimits = { ...limits, min_ssim: limits.min_ssim ?? null };
  const applied = raw.comparison.profile.case_override;
  if (applied) {
    const overrides = await reader.json(
      "tests/parity/tolerance-overrides.json",
      applied.catalog_sha256,
    );
    const override = overrides.cases[frame.case_id];
    assert.equal(applied.case_id, frame.case_id);
    assert.equal(override.profile, "gpu");
    assert(override.max_abs_channel_error <= 8);
    assert.equal(
      raw.comparison.profile.limits.max_abs_channel_error,
      override.max_abs_channel_error,
    );
    expectedLimits.max_abs_channel_error = override.max_abs_channel_error;
    expectedLimits.min_ssim = Math.max(limits.min_ssim ?? 0, 0.995);
    inputs.catalog.profiles.gpu = expectedLimits;
    assert(
      ledger.tolerance_overrides.some(
        (r) =>
          r.case_id === frame.case_id &&
          r.profile === "gpu" &&
          r.status === "accepted" &&
          r.catalog_sha256 === applied.catalog_sha256 &&
          r.max_abs_channel_error === override.max_abs_channel_error,
      ),
    );
  }
  assert.deepEqual(raw.comparison.profile.limits, expectedLimits);
  validateReport(
    raw,
    {
      entry,
      reference: { ...reference, meta: { rgba_sha256: reference.rgba_sha256 } },
      context: { case_id: frame.case_id, isolated: true, background: [0, 0, 0, 0], sequence: null },
      neighbors: {},
    },
    frame.step,
    inputs,
  );
  assert.equal(raw.comparison.passed, true);
  assert.equal((await reviewStatus(inputs, entry, raw)).status, "passed");
  for (const image of ["heatmap.png", "contact-sheet.png"])
    await reader.bytes(`${posix.dirname(frame.evidence)}/${image}`);
  return { reference, candidate };
}
