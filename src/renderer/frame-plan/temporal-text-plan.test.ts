import { expect, it } from "vitest";
import { decodeFramePlan } from "./codec";
import { temporalTextFixtures } from "./temporal-text-fixture";
import { readTextFrameSamplePlans } from "./temporal-text-frame";
import { readTemporalTextPlan } from "./temporal-text-plan";

it("consumes supplied sample times, weights and exposure flags after source disposal", () => {
  for (const fixture of temporalTextFixtures()) {
    const plan = decodeFramePlan(fixture.bytes.slice());
    expect(readTemporalTextPlan(plan)).toEqual(fixture.temporal);
    const slice = plan.metadata.slices[0];
    if (slice.kind !== "temporal_text_samples") throw new Error("Missing samples");
    slice.exposure_only = !slice.exposure_only;
    if (slice.unique_sample_count > 0) {
      const blob = plan.blobs[0];
      new DataView(blob.buffer, blob.byteOffset, blob.byteLength).setFloat64(16, -0.125, true);
    }
    const supplied = readTextFrameSamplePlans([structuredClone(plan)]);
    expect(supplied.exposureResourceIds.has(fixture.temporal.resourceInstanceId)).toBe(
      !fixture.temporal.exposureOnly,
    );
    if (slice.unique_sample_count > 0)
      expect(supplied.plans.get(fixture.temporal.resourceInstanceId)?.samples[0].localTime).toBe(
        -0.125,
      );
    expect(() => readTextFrameSamplePlans([plan, plan])).toThrow(/Duplicate text instance/);
  }
});

it("rejects changed formats, nonfinite samples, invalid exposure weights and mismatched frame time", () => {
  const fixture = temporalTextFixtures().find((fixture) => fixture.id === "temporal-exact-bits");
  if (!fixture) throw new Error("Missing exact fixture");
  for (const [offset, value] of [
    [0, 0],
    [8, 0.5],
    [16, Number.NaN],
    [24, -1],
    [32, 0.5],
  ]) {
    const plan = decodeFramePlan(fixture.bytes.slice());
    const blob = plan.blobs[0];
    new DataView(blob.buffer, blob.byteOffset, blob.byteLength).setFloat64(offset, value, true);
    expect(() => readTemporalTextPlan(plan)).toThrow(
      expect.objectContaining({ code: "invalid_temporal_text" }),
    );
  }
  const plan = decodeFramePlan(fixture.bytes);
  Object.assign(plan.metadata.slices[0], { accumulation_format: "rgba8unorm-srgb" });
  expect(() => readTemporalTextPlan(plan)).toThrow(
    expect.objectContaining({ code: "invalid_temporal_text" }),
  );
});
