import { describe, expect, it } from "vitest";
import { createLayerForComposition } from "../../core/layer-factory";
import { activeComposition, createDemoProject } from "../../core/project";
import type { Animatable } from "../../core/types";
import { collectAnimatedGraphTracks } from "./model";
import {
  fitGraphTimeRange,
  graphXToTime,
  graphYToValue,
  panGraphTimeRange,
  snapGraphTime,
  timeToGraphX,
  valueToGraphY,
  zoomGraphTimeRange,
  zoomGraphValueRange,
} from "./viewport";

const animated = (id: string, firstTime: number, lastTime: number): Animatable => ({
  mode: "animated",
  keyframes: [
    { id: `${id}-first`, time: firstTime, value: 0, interpolation: "linear" },
    { id: `${id}-last`, time: lastTime, value: 100, interpolation: "linear" },
  ],
});

describe("graph editor viewport math", () => {
  it("round-trips time and value coordinates", () => {
    const timeRange = { start: 2, end: 6 };
    const valueRange = { min: -50, max: 150 };
    expect(graphXToTime(timeToGraphX(3.25, timeRange), timeRange)).toBeCloseTo(3.25);
    expect(graphYToValue(valueToGraphY(42, valueRange), valueRange)).toBeCloseTo(42);
  });

  it("fits all keys or only selected keys without leaving the composition", () => {
    const composition = activeComposition(createDemoProject());
    composition.duration = 10;
    const layer = createLayerForComposition("shape", composition);
    layer.transform.position[0] = animated("position", 1, 8);
    layer.transform.opacity = animated("opacity", 3, 5);
    const tracks = collectAnimatedGraphTracks(layer);

    const all = fitGraphTimeRange(tracks, composition.duration);
    const selected = fitGraphTimeRange(
      tracks,
      composition.duration,
      new Set(["opacity-first", "opacity-last"]),
    );
    expect(all.start).toBeLessThanOrEqual(1);
    expect(all.end).toBeGreaterThanOrEqual(8);
    expect(selected.start).toBeLessThanOrEqual(3);
    expect(selected.end).toBeGreaterThanOrEqual(5);
    expect(selected.end - selected.start).toBeLessThan(all.end - all.start);
  });

  it("pans and anchor-zooms horizontally while clamping to composition time", () => {
    expect(panGraphTimeRange({ start: 2, end: 6 }, -10, 10)).toEqual({ start: 0, end: 4 });
    expect(panGraphTimeRange({ start: 2, end: 6 }, 10, 10)).toEqual({ start: 6, end: 10 });
    const zoomed = zoomGraphTimeRange({ start: 2, end: 6 }, 3, 0.5, 10);
    expect(zoomed.end - zoomed.start).toBeCloseTo(2);
    expect((3 - zoomed.start) / (zoomed.end - zoomed.start)).toBeCloseTo(0.25);
  });

  it("zooms vertically around the requested graph value", () => {
    const zoomed = zoomGraphValueRange({ min: -100, max: 100 }, 50, 0.5);
    expect(zoomed.max - zoomed.min).toBeCloseTo(100);
    expect((50 - zoomed.min) / (zoomed.max - zoomed.min)).toBeCloseTo(0.75);
  });

  it("snaps to the nearest frame or current time and supports bypass", () => {
    const frame = 1_001 / 30_000;
    expect(snapGraphTime(frame * 2.2, frame, 4, 100)).toBeCloseTo(frame * 2);
    expect(snapGraphTime(3.96, frame, 4, 100)).toBe(4);
    expect(snapGraphTime(3.96, frame, 4, 100, true)).toBe(3.96);
  });

  it("prefers the nearest graph landmark inside the pixel threshold", () => {
    const frame = 1 / 30;
    const targets = [1.1, 2.25, 3.75];
    expect(snapGraphTime(2.22, frame, 8, 100, false, targets)).toBe(2.25);
    expect(snapGraphTime(2.22, frame, 2.24, 100, false, targets)).toBe(2.24);
    expect(snapGraphTime(2.22, frame, 8, 100, true, targets)).toBe(2.22);
    expect(snapGraphTime(2.14, frame, 8, 100, false, targets, true)).toBe(2.14);
  });
});
