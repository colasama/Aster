import { describe, expect, it } from "vitest";
import { evaluateAnimatable, frameAt, insertKeyframe, timeAtFrame } from "./timeline";
import type { Animatable } from "./types";

describe("time-addressable animation", () => {
  it("evaluates a linear property at an arbitrary time", () => {
    const property: Animatable = {
      mode: "animated",
      keyframes: [
        { id: "a", time: 0, value: 10, interpolation: "linear" },
        { id: "b", time: 2, value: 30, interpolation: "linear" },
      ],
    };
    expect(evaluateAnimatable(property, 0.5)).toBe(15);
    expect(evaluateAnimatable(property, 9)).toBe(30);
  });

  it("maintains sorted keyframes and replaces timestamps", () => {
    const property = insertKeyframe(
      {
        mode: "animated",
        keyframes: [{ id: "late", time: 2, value: 20, interpolation: "linear" }],
      },
      { id: "early", time: 1, value: 10, interpolation: "step" },
    );
    expect(property.mode).toBe("animated");
    if (property.mode === "animated")
      expect(property.keyframes.map(({ id }) => id)).toEqual(["early", "late"]);
  });

  it("round-trips fractional frame rates", () => {
    const rate = { numerator: 24_000, denominator: 1_001 };
    expect(frameAt(timeAtFrame(240, rate), rate)).toBe(240);
  });
});
