import { expect, it } from "vitest";
import { BLEND_MODES } from "../../core/types";
import { suppliedLayerEffect } from "../effects/layer-effect-plan";
import { decodeFramePlan, encodeFramePlan } from "./codec";
import { layerEffectFixtures } from "./layer-effect-fixture";
import { readLayerEffectSlice } from "./layer-effect-plan";

it("owns compiled controls and LUT pixels after authored effects are removed", () => {
  for (const fixture of layerEffectFixtures()) {
    const plan = decodeFramePlan(fixture.bytes.slice());
    const decoded = readLayerEffectSlice(plan);
    expect(decoded).toEqual(fixture.effect);
    expect(new Uint8Array(decoded.program.data.buffer).slice(96)).toEqual(
      plan.blobs[0].slice(96, 4192),
    );
    expect(
      suppliedLayerEffect({ ...fixture.prepared, plan }, 64, 48, decoded.slice.route).program,
    ).toEqual(decoded.program);
    expect(() =>
      suppliedLayerEffect({ ...fixture.prepared, plan }, 65, 48, decoded.slice.route),
    ).toThrow("target or route");
    const missing = structuredClone(plan);
    missing.metadata.resources = [];
    expect(() => readLayerEffectSlice(missing)).toThrow();
  }
});

it("accepts every production blend and rejects inconsistent executable controls", () => {
  const fixture = layerEffectFixtures()[1];
  for (const blend of BLEND_MODES) {
    const plan = decodeFramePlan(fixture.bytes.slice());
    const slice = plan.metadata.slices[0];
    if (slice.kind !== "layer_effect") throw Error("Missing effect");
    slice.blend_mode = blend;
    expect(
      readLayerEffectSlice(decodeFramePlan(encodeFramePlan(plan.metadata, plan.blobs))).slice
        .blend_mode,
    ).toBe(blend);
  }
  for (const [offset, value] of [
    [0, 65],
    [64, 65],
    [68, 0],
    [72, 8],
    [76, 1],
  ]) {
    const plan = decodeFramePlan(fixture.bytes.slice());
    new DataView(plan.blobs[0].buffer, plan.blobs[0].byteOffset).setFloat32(offset, value, true);
    expect(() => readLayerEffectSlice(plan)).toThrow();
  }
});
