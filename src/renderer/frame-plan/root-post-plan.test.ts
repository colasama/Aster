import { describe, expect, it } from "vitest";
import { decodeFramePlan } from "./codec";
import { compositionIdentityToString } from "./composition-identity";
import { rootPostPlanFixtures } from "./fixture";
import { buildRootPostUniformPlan, type RootPostUniformPlanInput } from "./root-post-plan";
import { frameTimeToNumber } from "./time";

function request(time = 0): RootPostUniformPlanInput {
  return {
    snapshot: { snapshotScope: "editor:session/load-2", projectRevision: 17 },
    compositionId: "root",
    time,
    frameRate: { numerator: 48000, denominator: 2002 },
    target: { width: 320, height: 180 },
    renderTarget: { width: 640, height: 360 },
    antiAliasing: "ssaa2x",
  };
}

describe("root post uniform producer", () => {
  it("preserves the original 24-lane ABI across seeks, signed zero, overflow and SSAA", () => {
    for (const time of [
      0,
      -0,
      0.1,
      -1 / 3,
      (137 * 1001) / 24000,
      Number.MIN_VALUE,
      -1e-100,
      Number.MAX_VALUE,
      -Number.MAX_VALUE,
    ]) {
      for (const antiAliasing of ["off", "fxaa", "ssaa2x", "ssaa4x"] as const) {
        const input = request(time);
        input.antiAliasing = antiAliasing;
        const scale = antiAliasing === "ssaa4x" ? 4 : antiAliasing === "ssaa2x" ? 2 : 1;
        input.renderTarget = { width: 320 * scale, height: 180 * scale };
        const plan = buildRootPostUniformPlan(input);
        const expected = new Uint8Array(96);
        const view = new DataView(expected.buffer);
        [
          320 * scale,
          180 * scale,
          time,
          0,
          1,
          1,
          0,
          0,
          0,
          0.8,
          0,
          0,
          0,
          0,
          1,
          0,
          0,
          0,
          0,
          0,
          0.18,
          0,
          1,
          0,
        ].forEach((value, index) => {
          view.setFloat32(index * 4, value, true);
        });
        expect(plan.blobs).toEqual([expected]);
        expect(Object.is(frameTimeToNumber(plan.metadata.header.time), time)).toBe(true);
        expect(plan.metadata.renderer_plan_complete).toBe(false);
      }
    }
  });

  it("owns every input header field and each new payload", () => {
    const input = request(0.1);
    const snapshot = { ...input.snapshot };
    input.snapshot = snapshot;
    const plan = buildRootPostUniformPlan(input);
    const saved = structuredClone(plan);
    snapshot.snapshotScope = "other";
    snapshot.projectRevision = 999;
    input.frameRate.numerator = 1;
    input.target.width = 1;
    input.renderTarget.height = 1;
    input.time = 999;
    input.compositionId = "changed";
    input.antiAliasing = "off";
    expect(plan).toEqual(saved);
    const another = buildRootPostUniformPlan(request(0.1));
    plan.blobs[0].fill(0);
    expect(another).toEqual(saved);
  });

  it("builds independently decodable genuine root fixtures without quantizing request time", () => {
    for (const fixture of rootPostPlanFixtures()) {
      const decoded = decodeFramePlan(fixture.bytes);
      expect(Object.is(frameTimeToNumber(decoded.metadata.header.time), fixture.time)).toBe(true);
      expect(compositionIdentityToString(decoded.metadata.header.composition_id)).toBe(
        fixture.compositionId,
      );
      expect(decoded.metadata.slices).toHaveLength(1);
      expect(decoded.metadata.resources).toEqual([]);
    }
  });
});
