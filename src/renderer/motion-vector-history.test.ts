import { describe, expect, it } from "vitest";
import {
  buildMotionLayoutSignature,
  canReuseMotionHistory,
  MAX_REUSABLE_MOTION_FRAMES,
  motionHistoryBufferBytes,
  normalizedMotionShutterScale,
  planMotionHistory,
} from "./motion-vector-history";

const batch = (instanceId: string, firstVertex = 0, resourceInstanceId = instanceId) => ({
  instanceId,
  resourceInstanceId,
  firstVertex,
  vertexCount: 6,
});

describe("motion-vector history", () => {
  it("uses stable instance identity and topology for vertex correspondence", () => {
    const stable = buildMotionLayoutSignature([batch("nested:hero"), batch("nested:glow", 6)]);
    expect(buildMotionLayoutSignature([batch("nested:hero"), batch("nested:glow", 6)])).toBe(
      stable,
    );
    expect(buildMotionLayoutSignature([batch("nested:glow"), batch("nested:hero", 6)])).not.toBe(
      stable,
    );
    expect(buildMotionLayoutSignature([batch("nested:hero", 0, "new-resource")])).not.toBe(
      buildMotionLayoutSignature([batch("nested:hero")]),
    );
  });

  it("reuses only a forward sample within two composition frames and the same layout", () => {
    const previous = { timelineTime: 1, layoutSignature: "stable" };
    expect(canReuseMotionHistory(previous, { timelineTime: 1.02, layoutSignature: "stable" })).toBe(
      true,
    );
    expect(canReuseMotionHistory(previous, { timelineTime: 1, layoutSignature: "stable" })).toBe(
      false,
    );
    expect(canReuseMotionHistory(previous, { timelineTime: 0.9, layoutSignature: "stable" })).toBe(
      false,
    );
    expect(
      canReuseMotionHistory(previous, { timelineTime: 1.02, layoutSignature: "changed" }),
    ).toBe(false);
    expect(canReuseMotionHistory(previous, { timelineTime: 1.04, layoutSignature: "stable" })).toBe(
      false,
    );
    expect(
      canReuseMotionHistory(previous, { timelineTime: 1.04, layoutSignature: "stable" }, 25),
    ).toBe(true);
    expect(canReuseMotionHistory(undefined, { timelineTime: 1, layoutSignature: "stable" })).toBe(
      false,
    );
    expect(MAX_REUSABLE_MOTION_FRAMES).toBe(2);
  });

  it("normalizes actual history delta to a 180-degree composition shutter", () => {
    const previous = { timelineTime: 1, layoutSignature: "stable" };
    expect(
      normalizedMotionShutterScale(
        previous,
        { timelineTime: 1 + 1 / 60, layoutSignature: "stable" },
        60,
      ),
    ).toBeCloseTo(0.5);
    expect(
      normalizedMotionShutterScale(
        previous,
        { timelineTime: 1 + 1 / 120, layoutSignature: "stable" },
        60,
      ),
    ).toBeCloseTo(1);
    expect(
      normalizedMotionShutterScale(previous, { timelineTime: 1.5, layoutSignature: "stable" }, 60),
    ).toBe(0);
  });

  it("extracts current positions before the first pass so the first vector is zero", () => {
    const current = { timelineTime: 2, layoutSignature: "stable" };
    expect(planMotionHistory(undefined, current)).toEqual({
      extractBeforeRender: true,
      extractAfterRender: false,
      reusePreviousSample: false,
      shutterScale: 0,
    });
    const reused = planMotionHistory(
      { timelineTime: 2 - 1 / 60, layoutSignature: "stable" },
      current,
    );
    expect(reused).toMatchObject({
      extractBeforeRender: false,
      extractAfterRender: true,
      reusePreviousSample: true,
    });
    expect(reused.shutterScale).toBeCloseTo(0.5);
    expect(
      planMotionHistory({ timelineTime: 2 - 1 / 60, layoutSignature: "stable" }, current, true),
    ).toEqual({
      extractBeforeRender: true,
      extractAfterRender: false,
      reusePreviousSample: false,
      shutterScale: 0,
    });
    expect(planMotionHistory({ timelineTime: 1.5, layoutSignature: "stable" }, current)).toEqual({
      extractBeforeRender: true,
      extractAfterRender: false,
      reusePreviousSample: false,
      shutterScale: 0,
    });
  });

  it("reports the exact power-of-two GPU allocation", () => {
    expect(motionHistoryBufferBytes(0)).toBe(16);
    expect(motionHistoryBufferBytes(1)).toBe(16);
    expect(motionHistoryBufferBytes(6)).toBe(128);
    expect(() => motionHistoryBufferBytes(-1)).toThrow("non-negative safe integer");
  });
});
