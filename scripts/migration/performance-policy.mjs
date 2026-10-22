import assert from "node:assert/strict";

/** Select required gates from an explicit owner policy without implementing native benchmarks. */
export function selectRequiredGates(milestone, policy) {
  let approved = false;
  if (policy !== undefined) {
    assert(
      policy && typeof policy === "object" && !Array.isArray(policy),
      "Invalid performance delivery policy",
    );
    if (policy.status === "approved" || policy.authorization_received === true) {
      assert.equal(policy.kind, "rust-delivery-v1", "Unknown approved performance policy");
      assert.equal(policy.status, "approved", "Performance policy must be approved");
      assert.equal(
        policy.authorization_received,
        true,
        "Performance policy requires owner authorization",
      );
      assert(
        typeof policy.approved_at === "string" && Number.isFinite(Date.parse(policy.approved_at)),
        "Performance approval date is missing or invalid",
      );
      assert(
        typeof policy.authorization_text === "string" && policy.authorization_text.trim(),
        "Performance authorization text is missing",
      );
      assert.deepEqual(
        policy.intermediate_milestones,
        ["M2", "M4", "M6", "M7"],
        "Intermediate performance scope changed",
      );
      assert.equal(policy.intermediate_performance, "informational");
      assert.deepEqual(
        policy.native_milestones,
        ["M8", "M11", "M12"],
        "Native performance scope changed",
      );
      assert.equal(policy.native_performance, "higher-median-fps-than-contemporaneous-ts");
      if (policy.preview_latency !== undefined)
        assert.equal(
          policy.preview_latency,
          "input-to-present-p95-no-worse-than-contemporaneous-ts",
        );
      approved = true;
    }
  }
  const declared = milestone.gates;
  assert(
    Array.isArray(declared) && declared.includes("G0"),
    "The milestone must declare G0 and every required gate explicitly",
  );
  const intermediate = approved && policy.intermediate_milestones.includes(milestone.id);
  const native = approved && policy.native_milestones.includes(milestone.id);
  let required = [...declared];
  if (milestone.id === "M3") {
    assert.deepEqual([...declared].sort(), ["G0", "G1", "G3"], "M3 requires G0, G1 and G3");
  }
  if (milestone.id === "M2" || intermediate) {
    required =
      milestone.id === "M2"
        ? intermediate
          ? ["G0", "G1", "G3"]
          : ["G0", "G1", "G3", "G4"]
        : ["G0", "G3"];
    const names = `${required.slice(0, -1).join(", ")} and ${required.at(-1)}`;
    assert(
      declared.length === required.length && required.every((id) => declared.includes(id)),
      `${milestone.id} requires ${names} ${intermediate ? "under the approved owner policy" : "according to the migration specification"}`,
    );
  }
  assert(
    declared.every((id) => typeof id === "string" && /^G\d+$/.test(id)),
    "Invalid required gate identifier",
  );
  assert.equal(
    new Set(declared).size,
    declared.length,
    "Required gates must not contain duplicates",
  );
  if (milestone.id === "M0")
    assert(
      declared.includes("G6"),
      "M0 requires both G0 and G6 according to the migration specification",
    );
  if (native)
    assert(
      declared.includes("G4"),
      "Native delivery still requires a performance gate; it is not implemented by this policy selector",
    );
  const reason =
    "The owner authorized informational performance during intermediate migration stages; applicable functional, IR and pixel gates remain required. Native preview/export performance remains a future required gate.";
  return {
    required_gates: required,
    optional_gates: intermediate ? [{ id: "G4", status: "not_required", reason }] : [],
    performance_policy: approved
      ? {
          ...structuredClone(policy),
          application: intermediate
            ? "intermediate-informational"
            : native
              ? "native-required"
              : "unchanged",
          native_gate_implementation:
            milestone.id === "M8"
              ? "paired-native-export"
              : milestone.id === "M11"
                ? "paired-native-preview-with-input-latency"
                : "not_implemented",
        }
      : { kind: "specification-default", application: "unchanged" },
  };
}
