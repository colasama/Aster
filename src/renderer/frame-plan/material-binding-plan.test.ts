import { expect, it } from "vitest";
import { materialBindingUniforms } from "../media/material-texture-plan";
import { decodeFramePlan, encodeFramePlan } from "./codec";
import { materialBindingFixtures } from "./material-binding-fixture";
import { readMaterialBindingSlice } from "./material-binding-plan";

it("preserves material activity, exact scalar bits and supplied hashes across FPLN", () => {
  for (const fixture of materialBindingFixtures()) {
    const plan = decodeFramePlan(fixture.bytes);
    const binding = readMaterialBindingSlice(structuredClone(plan));
    expect(binding).toEqual(fixture.material);
    expect(materialBindingUniforms(binding)).toEqual(materialBindingUniforms(fixture.material));
    expect(encodeFramePlan(plan.metadata, plan.blobs)).toEqual(fixture.bytes);
  }
});

it("rejects missing hashes, conflicting roles, and malformed material scalars", () => {
  const fixture = materialBindingFixtures()[3];
  const absent = structuredClone(fixture.plan);
  absent.metadata.resources = [];
  expect(() => readMaterialBindingSlice(absent)).toThrow();
  const conflicting = structuredClone(fixture.plan);
  const slice = conflicting.metadata.slices[0];
  if (slice.kind !== "material_binding") throw Error("Wrong fixture");
  slice.normal = slice.environment;
  expect(() => readMaterialBindingSlice(conflicting)).toThrow();
  for (const [offset, value] of [
    [0, NaN],
    [0, 9],
    [8, -1],
    [8, Infinity],
    [16, 1],
  ]) {
    const invalid = structuredClone(fixture.plan);
    new DataView(invalid.blobs[0].buffer).setFloat64(offset, value, true);
    expect(() => readMaterialBindingSlice(invalid)).toThrow();
  }
  const missingEnvironment = structuredClone(fixture.plan);
  const material = missingEnvironment.metadata.slices[0];
  if (material.kind !== "material_binding") throw Error("Wrong fixture");
  material.environment = { kind: "fallback" };
  expect(() => readMaterialBindingSlice(missingEnvironment)).toThrow();
});
