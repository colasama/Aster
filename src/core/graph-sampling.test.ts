import { describe, expect, it } from "vitest";
import { graphSampleCount, sampleGraph } from "./graph-sampling";
import { evaluateAnimatable, timeAtFrame } from "./timeline";
import type { Animatable } from "./types";

describe("time-addressable graph sampling", () => {
  it("adapts count to the display pixel budget and spacing to the visible time interval", () => {
    expect(graphSampleCount(2, 100)).toBe(101);
    expect(graphSampleCount(2, 400)).toBe(401);
    expect(graphSampleCount(2, 400, 2, 256)).toBe(256);

    const short = sampleGraph({
      evaluate: (time) => time,
      startTime: 0,
      endTime: 1,
      pixelWidth: 10,
    });
    const long = sampleGraph({
      evaluate: (time) => time,
      startTime: 0,
      endTime: 8,
      pixelWidth: 10,
    });
    expect(short.count).toBe(11);
    expect(long.count).toBe(11);
    expect(short.timeStep).toBeCloseTo(0.1);
    expect(long.timeStep).toBeCloseTo(0.8);
  });

  it("samples negative linear values and reports numerical speed in value per second", () => {
    const property: Animatable = {
      mode: "animated",
      keyframes: [
        { id: "a", time: 0, value: -30, interpolation: "linear" },
        { id: "b", time: 2, value: 10, interpolation: "linear" },
      ],
    };
    const samples = sampleGraph({
      evaluate: (time) => evaluateAnimatable(property, time),
      startTime: 0,
      endTime: 2,
      pixelWidth: 64,
    });

    expect(samples.values[0]).toBe(-30);
    expect(samples.values[samples.count - 1]).toBe(10);
    for (let index = 0; index < samples.count; index += 1)
      expect(samples.speeds[index]).toBeCloseTo(20, 8);
  });

  it("accepts an analytic speed evaluator for hold interpolation", () => {
    const property: Animatable = {
      mode: "animated",
      keyframes: [
        { id: "a", time: 0, value: 4, interpolation: "step" },
        { id: "b", time: 1, value: 20, interpolation: "linear" },
      ],
    };
    const samples = sampleGraph({
      evaluate: (time) => evaluateAnimatable(property, time),
      evaluateSpeed: () => 0,
      startTime: 0,
      endTime: 1,
      pixelWidth: 32,
    });

    expect(samples.values[0]).toBe(4);
    expect(samples.values[Math.floor(samples.count / 2)]).toBe(4);
    expect(samples.values[samples.count - 1]).toBe(20);
    expect([...samples.speeds.subarray(0, samples.count)]).toEqual(
      Array.from({ length: samples.count }, () => 0),
    );
  });

  it("preserves temporal Bezier overshoot instead of bounding samples to keyframe values", () => {
    const property: Animatable = {
      mode: "animated",
      keyframes: [
        {
          id: "a",
          time: 0,
          value: 0,
          interpolation: "bezier",
          easing: [0.25, 1.8, 0.75, 1.8],
        },
        { id: "b", time: 1, value: 100, interpolation: "linear" },
      ],
    };
    const samples = sampleGraph({
      evaluate: (time) => evaluateAnimatable(property, time),
      startTime: 0,
      endTime: 1,
      pixelWidth: 512,
      maxSamples: 1_024,
    });

    expect(Math.max(...samples.values.subarray(0, samples.count))).toBeGreaterThan(100);
    expect([...samples.speeds.subarray(0, samples.count)].every(Number.isFinite)).toBe(true);
  });

  it("subdivides curved segments to a bounded screen-space error at low zoom", () => {
    const property: Animatable = {
      mode: "animated",
      keyframes: [
        {
          id: "a",
          time: 0,
          value: 0,
          interpolation: "bezier",
          easing: [0.08, 2.8, 0.22, 1.4],
        },
        { id: "b", time: 1, value: 100, interpolation: "linear" },
      ],
    };
    const samples = sampleGraph({
      evaluate: (time) => evaluateAnimatable(property, time),
      startTime: 0,
      endTime: 1,
      pixelWidth: 4,
      pixelHeight: 400,
      maxSamples: 256,
      breakpoints: property.keyframes.map((keyframe) => keyframe.time),
    });
    const reference = Array.from({ length: 20_001 }, (_, index) =>
      evaluateAnimatable(property, index / 20_000),
    );

    expect(samples.count).toBeGreaterThan(5);
    expect(samples.count).toBeLessThanOrEqual(256);
    expect(samples.timeStep).toBe(0);
    expect(Math.max(...samples.values.subarray(0, samples.count))).toBeCloseTo(
      Math.max(...reference),
      1,
    );
  });

  it("samples visible breakpoints exactly without losing the interval endpoints", () => {
    const samples = sampleGraph({
      evaluate: (time) => time,
      startTime: 0,
      endTime: 1,
      pixelWidth: 2,
      breakpoints: [-1, 0.375, 2],
    });

    expect([...samples.times.subarray(0, samples.count)]).toContain(0.375);
    expect(samples.times[0]).toBe(0);
    expect(samples.times[samples.count - 1]).toBe(1);
  });

  it("handles zero display duration and coincident keyframes deterministically", () => {
    const property: Animatable = {
      mode: "animated",
      keyframes: [
        { id: "a", time: 1, value: 10, interpolation: "linear" },
        { id: "b", time: 1, value: 30, interpolation: "linear" },
      ],
    };
    const samples = sampleGraph({
      evaluate: (time) => evaluateAnimatable(property, time),
      startTime: 1,
      endTime: 1,
      pixelWidth: 800,
    });

    expect(samples.count).toBe(1);
    expect(samples.timeStep).toBe(0);
    expect(samples.values[0]).toBe(30);
    expect(samples.speeds[0]).toBe(0);
  });

  it("keeps fractional-frame-rate sampling and value-per-second speed precise", () => {
    const frameRate = { numerator: 30_000, denominator: 1_001 };
    const endTime = timeAtFrame(240, frameRate);
    const rate = frameRate.numerator / frameRate.denominator;
    const samples = sampleGraph({
      evaluate: (time) => -12 + time * rate,
      startTime: timeAtFrame(120, frameRate),
      endTime,
      pixelWidth: 320,
    });

    expect(samples.times[0]).toBeCloseTo(timeAtFrame(120, frameRate), 12);
    expect(samples.times[samples.count - 1]).toBeCloseTo(endTime, 12);
    for (let index = 0; index < samples.count; index += 1)
      expect(samples.speeds[index]).toBeCloseTo(rate, 8);
  });

  it("sanitizes non-finite evaluator output and reuses a sufficiently large target", () => {
    const first = sampleGraph({
      evaluate: (time) => (time < 0.25 ? Number.NaN : time > 0.75 ? Number.POSITIVE_INFINITY : 8),
      startTime: 0,
      endTime: 1,
      pixelWidth: 16,
    });
    expect([...first.values.subarray(0, first.count)].every(Number.isFinite)).toBe(true);
    expect([...first.speeds.subarray(0, first.count)].every(Number.isFinite)).toBe(true);

    const reused = sampleGraph({
      evaluate: (time) => time * 2,
      startTime: 0,
      endTime: 1,
      pixelWidth: 8,
      target: first,
    });
    expect(reused).toBe(first);
    expect(reused.count).toBe(9);
  });

  it("rejects invalid intervals and allocation controls before evaluation", () => {
    const evaluate = () => 0;
    expect(() =>
      sampleGraph({ evaluate, startTime: Number.NaN, endTime: 1, pixelWidth: 100 }),
    ).toThrow("times must be finite");
    expect(() => sampleGraph({ evaluate, startTime: 2, endTime: 1, pixelWidth: 100 })).toThrow(
      "must not precede",
    );
    expect(() => sampleGraph({ evaluate, startTime: 0, endTime: 1, pixelWidth: -1 })).toThrow(
      "pixel width",
    );
    expect(() =>
      sampleGraph({ evaluate, startTime: 0, endTime: 1, pixelWidth: 10, maxSamples: 0 }),
    ).toThrow("maximum");
    expect(() =>
      sampleGraph({ evaluate, startTime: 0, endTime: 1, pixelWidth: 10, pixelHeight: 0 }),
    ).toThrow("pixel height");
  });
});
