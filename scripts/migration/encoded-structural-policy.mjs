import assert from "node:assert/strict";

export const encodedStructuralPolicy = "encoded-preencode-structural-witness-v1";

/** Eligibility only: acceptance additionally requires authenticated witnesses and direct review. */
export function encodedStructuralAlternatives(comparison) {
  const c = comparison;
  assert.equal(c.profile.name, "yuv");
  assert.equal(
    c.passed,
    c.checks.every((check) => check.passed),
  );
  const ids = c.checks.map((check) => check.id);
  assert.equal(new Set(ids).size, ids.length, "Duplicate encoded check");
  const required = ["psnr", "error_clusters", "signed_bias", "alpha_coverage", "registration"];
  if (c.isolated) required.push("ink_bounds");
  if (c.sequence) required.push("frame_identity");
  assert.deepEqual(ids.toSorted(), required.toSorted(), "Incomplete encoded checks");
  const failed = c.checks.filter((check) => !check.passed).map((check) => check.id);
  if (!failed.length) return [];
  if (failed.some((id) => !["ink_bounds", "registration"].includes(id))) return null;
  // A measured displacement can never be replaced by an unobservable-registration witness.
  if (c.registration.status === "measured") {
    const shift = c.registration.shift;
    if (
      !shift ||
      ![shift.dx, shift.dy, shift.distance].every(Number.isFinite) ||
      shift.distance < 0 ||
      Math.abs(Math.hypot(shift.dx, shift.dy) - shift.distance) > 1e-8 ||
      shift.distance > 0.25
    )
      return null;
  }
  if (
    failed.includes("registration") &&
    (c.registration.status !== "indeterminate" || c.registration.shift !== null)
  )
    return null;
  return failed.map((id) => (id === "registration" ? "unobservable_registration" : id)).toSorted();
}

export function assertEncodedStructuralAuthorization(ledger) {
  const policy = ledger.owner_overrides?.layered_structural_policy;
  assert.equal(policy?.kind, encodedStructuralPolicy);
  assert.equal(policy.approved, true);
  assert.equal(policy.scope, "G5-only");
  assert.deepEqual(policy.allowed_alternatives, ["ink_bounds", "unobservable_registration"]);
  for (const key of [
    "same_case_frame_source_required",
    "measured_over_limit_shift_rejected",
    "other_quality_limits_unchanged",
    "preserve_original_failures",
  ])
    assert.equal(policy[key], true);
  return policy;
}
