import { describe, expect, it } from "vitest";
import type { GeometryResult } from "./geometry";
import { FLOATS_PER_VERTEX } from "./geometry";
import {
  buildTimeAddressedMotionVectors,
  motionVectorBufferBytes,
} from "./time-addressed-motion-vectors";

describe("time-addressed motion vectors", () => {
  it("uses shutter endpoints and the stable instance identity", () => {
    const current = geometry("root/layer", 0, 0);
    const open = geometry("root/layer", -0.25, -0.5);
    const close = geometry("root/layer", 0.75, 0.5);
    expect(buildTimeAddressedMotionVectors(current, open, close, new Set(["layer"]))).toEqual(
      new Float32Array([0.5, -0.5]),
    );
  });

  it("zeros disabled layers and topology changes instead of reusing history", () => {
    const current = geometry("root/layer", 0, 0);
    const moved = geometry("root/layer", 1, 1);
    expect(buildTimeAddressedMotionVectors(current, current, moved, new Set())).toEqual(
      new Float32Array([0, 0]),
    );
    moved.batches[0].vertexCount = 2;
    expect(buildTimeAddressedMotionVectors(current, current, moved, new Set(["layer"]))).toEqual(
      new Float32Array([0, 0]),
    );
  });

  it("keeps GPU allocation bounded and power-of-two", () => {
    expect(motionVectorBufferBytes(0)).toBe(8);
    expect(motionVectorBufferBytes(3)).toBe(32);
    expect(() => motionVectorBufferBytes(-1)).toThrow("non-negative");
  });
});

function geometry(instanceId: string, x: number, y: number): GeometryResult {
  const data = new Float32Array(FLOATS_PER_VERTEX);
  data[0] = x;
  data[1] = y;
  return {
    data,
    batches: [
      {
        layer: { id: "layer" } as GeometryResult["batches"][number]["layer"],
        instanceId,
        resourceInstanceId: instanceId,
        selectionId: "layer",
        firstVertex: 0,
        vertexCount: 1,
      },
    ],
  };
}
