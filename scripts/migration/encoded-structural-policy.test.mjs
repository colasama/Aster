import assert from "node:assert/strict";
import test from "node:test";
import { encodedStructuralAlternatives } from "./encoded-structural-policy.mjs";

function comparison(failed = ["ink_bounds"]) {
  return {
    profile: { name: "yuv" },
    passed: failed.length === 0,
    isolated: true,
    sequence: { frame: 1 },
    registration: { status: "measured", shift: { dx: 0, dy: 0, distance: 0 } },
    checks: [
      "psnr",
      "error_clusters",
      "signed_bias",
      "alpha_coverage",
      "registration",
      "ink_bounds",
      "frame_identity",
    ].map((id) => ({ id, passed: !failed.includes(id) })),
  };
}
test("only ink-bound failures and explicitly unobservable registration are witness-eligible", () => {
  assert.deepEqual(encodedStructuralAlternatives(comparison()), ["ink_bounds"]);
  assert.deepEqual(encodedStructuralAlternatives(comparison([])), []);
  const c = comparison(["ink_bounds", "registration"]);
  c.registration = { status: "indeterminate", shift: null };
  assert.deepEqual(encodedStructuralAlternatives(c), ["ink_bounds", "unobservable_registration"]);
  for (const id of ["psnr", "error_clusters", "signed_bias", "alpha_coverage", "frame_identity"])
    assert.equal(encodedStructuralAlternatives(comparison(["ink_bounds", id])), null);
});
test("measured over-limit shifts, missing evidence and inconsistent measurements cannot use witnesses", () => {
  for (const distance of [0.250001, 0.26, 1, NaN]) {
    const c = comparison(["registration"]);
    c.registration.shift = { dx: distance, dy: 0, distance };
    assert.equal(encodedStructuralAlternatives(c), null);
  }
  const c = comparison();
  c.registration.shift = { dx: 0.3, dy: 0, distance: 0 };
  assert.equal(encodedStructuralAlternatives(c), null);
  c.registration = { status: "indeterminate", shift: { dx: 0, dy: 0, distance: 0 } };
  c.checks.find((x) => x.id === "registration").passed = false;
  assert.equal(encodedStructuralAlternatives(c), null);
  for (const mutate of [
    (c) => c.checks.pop(),
    (c) => c.checks.push(c.checks[0]),
    (c) => (c.profile.name = "gpu"),
    (c) => (c.passed = true),
  ]) {
    const c = comparison();
    mutate(c);
    assert.throws(() => encodedStructuralAlternatives(c));
  }
});
