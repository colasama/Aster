import { describe, expect, it } from "vitest";
import { createEffect } from "../effects/registry";
import {
  evaluateAnimatable,
  evaluateAnimatableSpeed,
  evaluateEffectParameter,
  frameAt,
  insertKeyframe,
  timeAtFrame,
} from "./timeline";
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

  it("evaluates exact linear, temporal Bezier, hold, and spatial derivatives", () => {
    const linear: Animatable = {
      mode: "animated",
      keyframes: [
        { id: "a", time: 0, value: 0, interpolation: "linear" },
        { id: "b", time: 2, value: 20, interpolation: "linear" },
      ],
    };
    expect(evaluateAnimatableSpeed(linear, 1)).toBeCloseTo(10, 10);
    expect(evaluateAnimatableSpeed(linear, -1)).toBe(0);
    expect(evaluateAnimatableSpeed(linear, 2)).toBeCloseTo(10, 10);
    expect(evaluateAnimatableSpeed(linear, 2.1)).toBe(0);

    const eased: Animatable = {
      mode: "animated",
      keyframes: [
        {
          id: "a",
          time: 0,
          value: 0,
          interpolation: "bezier",
          easing: [0.25, 0, 0.75, 1],
        },
        { id: "b", time: 1, value: 100, interpolation: "linear" },
      ],
    };
    const epsilon = 1e-5;
    const numerical =
      (evaluateAnimatable(eased, 0.5 + epsilon) - evaluateAnimatable(eased, 0.5 - epsilon)) /
      (2 * epsilon);
    expect(evaluateAnimatableSpeed(eased, 0.5)).toBeCloseTo(numerical, 4);

    const spatial: Animatable = {
      mode: "animated",
      keyframes: [
        { id: "a", time: 0, value: 0, interpolation: "linear", spatialOut: 50 },
        { id: "b", time: 1, value: 100, interpolation: "linear", spatialIn: -20 },
      ],
    };
    const spatialNumerical =
      (evaluateAnimatable(spatial, 0.5 + epsilon) - evaluateAnimatable(spatial, 0.5 - epsilon)) /
      (2 * epsilon);
    expect(evaluateAnimatableSpeed(spatial, 0.5)).toBeCloseTo(spatialNumerical, 4);
    expect(
      evaluateAnimatableSpeed(
        {
          mode: "animated",
          keyframes: [
            { id: "a", time: 0, value: 0, interpolation: "step" },
            { id: "b", time: 1, value: 100, interpolation: "linear" },
          ],
        },
        0.5,
      ),
    ).toBe(0);
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

  it("evaluates value-relative spatial Bezier handles after temporal easing", () => {
    const property: Animatable = {
      mode: "animated",
      keyframes: [
        {
          id: "a",
          time: 0,
          value: 0,
          interpolation: "linear",
          spatialOut: 50,
        },
        {
          id: "b",
          time: 1,
          value: 100,
          interpolation: "linear",
          spatialIn: -50,
        },
      ],
    };

    expect(evaluateAnimatable(property, 0.25)).toBeCloseTo(29.6875);
    expect(evaluateAnimatable(property, 0.75)).toBeCloseTo(70.3125);
  });

  it("round-trips fractional frame rates", () => {
    const rate = { numerator: 24_000, denominator: 1_001 };
    expect(frameAt(timeAtFrame(240, rate), rate)).toBe(240);
  });

  it("evaluates effect parameters independently at arbitrary times", () => {
    const effect = createEffect("exposure");
    effect.parameterKeyframes = {
      exposure: [
        { id: "start", time: 0, value: -1, interpolation: "linear" },
        { id: "end", time: 2, value: 3, interpolation: "linear" },
      ],
    };
    expect(evaluateEffectParameter(effect, "exposure", 0.5)).toBe(0);
    expect(evaluateEffectParameter(effect, "gamma", 0.5, 1)).toBe(1);
  });
});
