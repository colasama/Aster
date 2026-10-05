import { describe, expect, it } from "vitest";
import { decodeFramePlan, encodeFramePlan } from "./codec";
import { finalOutputFixtures } from "./final-output-fixture";
import { readFinalOutputPlan } from "./final-output-plan";

describe("final output transport", () => {
  it("owns all display routes, availability fallbacks and AA modes across FPLN", () => {
    for (const fixture of finalOutputFixtures()) {
      const decoded = decodeFramePlan(fixture.bytes);
      const output = readFinalOutputPlan(decoded);
      expect(output.route).toEqual(fixture.output.route);
      expect(output.header.aa).toBe(fixture.output.aa);
      expect(output.clear).toEqual({ r: 0, g: 0, b: 0, a: 1 });
      const owned = structuredClone(output);
      decoded.blobs[0].fill(0);
      expect(output).toEqual(owned);
    }
  });
  it("rejects invalid modes, unused resources and nonfinite clear values", () => {
    const { plan } = finalOutputFixtures()[0];
    const slice = plan.metadata.slices[0];
    if (slice.kind !== "final_output") throw Error("Missing output");
    Object.assign(slice.route, { kind: "depth", mode: "beauty" });
    expect(() => encodeFramePlan(plan.metadata, plan.blobs)).toThrow();
    const other = finalOutputFixtures()[0].plan;
    other.metadata.resources = ["a".repeat(64)];
    expect(() => readFinalOutputPlan(other)).toThrow(/transient slice/);
    other.metadata.resources = [];
    new DataView(other.blobs[0].buffer).setFloat32(0, NaN, true);
    expect(() => encodeFramePlan(other.metadata, other.blobs)).toThrow(/clear color/);
  });
});
