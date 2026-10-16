import assert from "node:assert/strict";
import test from "node:test";
import { auditDiagnosticStructuralWitness } from "./diagnostic-structural-audit.mjs";
import { encodedStructuralPolicy } from "./encoded-structural-policy.mjs";
import { fixture } from "./m0-exit-fixtures.mjs";

test("diagnostic witnesses reject cross-source, cross-case, replay and binary substitutions", async (t) => {
  const f = await fixture(t);
  await f.json("proposal.json", {});
  const ledger = {
    owner_overrides: {
      layered_structural_policy: {
        kind: encodedStructuralPolicy,
        approved: true,
        scope: "G5-only",
        allowed_alternatives: ["ink_bounds", "unobservable_registration"],
        same_case_frame_source_required: true,
        measured_over_limit_shift_rejected: true,
        other_quality_limits_unchanged: true,
        preserve_original_failures: true,
        proposal: { path: "proposal.json", sha256: await f.hash("proposal.json") },
      },
    },
  };
  const binary = { path: "native.exe", sha256: "a".repeat(64) };
  const input = { path: "capture.json", sha256: "b".repeat(64) };
  const original = {
    kind: encodedStructuralPolicy,
    input_kind: "production-diagnostic",
    case_id: "native-encoded-root",
    source_unchanged: true,
    execution_sha256: "c".repeat(64),
    binary,
    capture: input,
  };
  for (const mutate of [
    (w) => {
      w.execution_sha256 = "d".repeat(64);
    },
    (w) => {
      w.case_id = "native-encoded-recursive";
    },
    (w) => {
      w.input_kind = "corpus-replay";
    },
    (w) => {
      w.binary.sha256 = "d".repeat(64);
    },
    (w) => {
      w.capture.sha256 = "d".repeat(64);
    },
    (w) => {
      w.source_unchanged = false;
    },
  ]) {
    const witness = structuredClone(original);
    mutate(witness);
    await f.json("witness.json", witness);
    const pin = { path: "witness.json", sha256: await f.hash("witness.json") };
    await assert.rejects(
      auditDiagnosticStructuralWitness(
        f.root,
        { id: original.case_id, structural_witness: pin },
        {
          status: "diagnostic",
          production_route: true,
          source_unchanged: true,
          source: { source_sha256: "e".repeat(64), execution_sha256: original.execution_sha256 },
          source_after: { source_sha256: "e".repeat(64) },
          binary,
          input,
          structural_witness: pin,
        },
        ledger,
      ),
      { code: "ERR_ASSERTION" },
    );
  }
});
