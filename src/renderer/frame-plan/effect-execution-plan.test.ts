import { expect, it } from "vitest";
import { effectExecution, suppliedLayerEffect } from "../effects/layer-effect-plan";
import { decodeFramePlan } from "./codec";
import { effectExecutionFixtures } from "./effect-execution-fixture";
import { readEffectExecutionSlice } from "./effect-execution-plan";

it("retains routing, fusion and deferred failures after authoring is removed", () => {
  const fixtures = effectExecutionFixtures();
  for (const f of fixtures)
    expect(readEffectExecutionSlice(decodeFramePlan(f.bytes))).toEqual(f.execution);
  const get = (id: string) => {
    const f = fixtures.find((f) => f.id === `execution-${id}`);
    if (!f) throw Error("Missing fixture");
    return f;
  };
  expect(get("direct").execution.route).toBe("direct");
  expect(get("root-skip").execution.route).toBe("skip");
  expect(get("precomposition-noop").execution).toMatchObject({
    route: "adjustment",
    composite: "replace",
  });
  expect(get("precomposition-noop").prepared.status).toBe("skipped");
  expect(get("overflow").execution.fusion).toEqual({
    fusedEffectCount: 64,
    fusedGroupCount: 1,
    barrierCount: 6,
    operationCount: 64,
  });
  expect(get("disabled").prepared.status).toBe("direct");
  expect(get("failed-lut").prepared.status).toBe("failed");
  expect(effectExecution(get("failed-lut").prepared).route).toBe("adjustment");
  expect(() => suppliedLayerEffect(get("failed-lut").prepared, 64, 48, "adjustment")).toThrow(
    "RGB triplets",
  );
});

it("rejects inconsistent composites, corrupt fusion counts and cross-frame program pairing", () => {
  const fixture = effectExecutionFixtures()[0];
  const plan = decodeFramePlan(fixture.bytes.slice());
  const slice = plan.metadata.slices[0];
  if (slice.kind !== "effect_execution") throw Error("Wrong fixture");
  slice.composite = "backdrop";
  expect(() => readEffectExecutionSlice(plan)).toThrow("route/composite");
  const counts = decodeFramePlan(fixture.bytes.slice());
  new DataView(counts.blobs[0].buffer, counts.blobs[0].byteOffset).setUint32(12, 65, true);
  expect(() => readEffectExecutionSlice(counts)).toThrow("fusion counts");
  const prepared = structuredClone(fixture.prepared);
  prepared.execution.metadata.header.project_revision += 1;
  expect(() => suppliedLayerEffect(prepared, 64, 48, "layer")).toThrow("bindings differ");
});
