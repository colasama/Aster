import { describe, expect, it } from "vitest";
import {
  adjacentTimelineEvent,
  marqueeTimelineSelection,
  moveLayerTimingGroup,
  normalizeWorkArea,
  snapTimelineTime,
  trimLayerTimingGroup,
} from "./timeline-editing";

const frame = 1 / 30;

describe("After Effects-style timeline editing primitives", () => {
  it("prefers nearby magnetic edit points and supports Control bypass", () => {
    expect(snapTimelineTime(1.08, frame, 100, [{ time: 1.1, kind: "playhead" }])).toEqual({
      time: 1.1,
      kind: "playhead",
      targetId: undefined,
    });
    expect(snapTimelineTime(1.08, frame, 100, [], false).time).toBeCloseTo(1.0666667);
    expect(snapTimelineTime(1.081, frame, 100, [{ time: 1.1, kind: "playhead" }], true)).toEqual({
      time: 1.081,
      kind: "frame",
    });
  });

  it("moves multiple layers as one bounded transaction and ignores self snap targets", () => {
    const moved = moveLayerTimingGroup(
      [
        { id: "a", inPoint: 1, outPoint: 3 },
        { id: "b", inPoint: 2, outPoint: 5 },
      ],
      "a",
      9,
      10,
      frame,
      100,
      [{ id: "a", time: 1.02, kind: "layer-in" }],
    );
    expect(moved).toEqual([
      { id: "a", inPoint: 6, outPoint: 8 },
      { id: "b", inPoint: 7, outPoint: 10 },
    ]);
  });

  it("trims a selected layer group without crossing one-frame durations", () => {
    const trimmed = trimLayerTimingGroup(
      [
        { id: "a", inPoint: 1, outPoint: 2 },
        { id: "b", inPoint: 1.5, outPoint: 1.7 },
      ],
      "in",
      "a",
      4,
      10,
      frame,
      100,
    );
    expect(trimmed[1].outPoint - trimmed[1].inPoint).toBeCloseTo(frame);
    expect(trimmed[0].inPoint).toBeCloseTo(1.1666667);
  });

  it("normalizes work areas to frames and guarantees a non-empty range", () => {
    expect(normalizeWorkArea(1.01, 2.02, 10, frame)).toEqual({ start: 1, end: 2.033333333333333 });
    expect(normalizeWorkArea(10, 10, 10, frame)).toEqual({
      start: 9.966666666666667,
      end: 10,
    });
  });

  it("marquee-selects inclusive rows/times and navigates sorted unique events", () => {
    const points = [
      { id: "late", time: 2, row: 2 },
      { id: "early", time: 1, row: 1 },
      { id: "outside", time: 3, row: 4 },
    ];
    expect(marqueeTimelineSelection(points, 2.1, 0.9, 2, 1)).toEqual(["late", "early"]);
    expect(adjacentTimelineEvent([2, 1, 2, Number.NaN], 1.5, -1)).toBe(1);
    expect(adjacentTimelineEvent([2, 1, 2], 1.5, 1)).toBe(2);
    expect(adjacentTimelineEvent([1], 1, 1)).toBeUndefined();
  });
});
