import { describe, expect, it } from "vitest";
import type { Composition, Layer } from "../../core/types";
import {
  buildTimelineSnapTargets,
  editLayerTimingGroup,
  excludeTimelineSnapTargets,
  layerTimingOperations,
  moveWorkArea,
  resolveTimelineShortcut,
  setWorkAreaBoundary,
  timelineContentPoint,
  timelineMarqueeRect,
} from "./timeline-interactions";

const frame = 1 / 30;

describe("timeline UI interaction model", () => {
  it("moves all selected layers by the same bounded delta and ignores their own keys for snapping", () => {
    const layers = [layer("a", 2, 4), layer("b", 3, 6)];
    layers[0].transform.opacity = {
      mode: "animated",
      keyframes: [{ id: "own", time: 2.5, value: 50, interpolation: "linear" }],
    };
    layers[1].timeRemap = {
      mode: "animated",
      keyframes: [{ id: "hidden", time: 1, value: 7, interpolation: "linear" }],
    };
    const composition = {
      duration: 12,
      frameRate: { numerator: 30, denominator: 1 },
      layers,
    } as Composition;
    const targets = buildTimelineSnapTargets(composition, 8, { start: 0, end: 12 });
    const snapped = editLayerTimingGroup(
      layers,
      "a",
      "move",
      2.46,
      composition,
      100,
      targets,
      false,
    );
    expect(snapped[0].inPoint).toBeCloseTo(2 + 14 / 30);
    const bounded = editLayerTimingGroup(layers, "a", "move", 0, composition, 100, targets, true);
    expect(bounded).toEqual([
      { id: "a", inPoint: 1, outPoint: 3 },
      { id: "b", inPoint: 2, outPoint: 5 },
    ]);
    expect(layerTimingOperations(bounded, layers, "move")).toEqual([
      { type: "moveLayer", layerId: "a", delta: -1 },
      { type: "moveLayer", layerId: "b", delta: -1 },
    ]);
    expect(layerTimingOperations(layers, layers, "move")).toEqual([]);
    const trimmed = editLayerTimingGroup(
      layers,
      "a",
      "trim-in",
      0,
      composition,
      100,
      targets,
      true,
    );
    expect(trimmed[0].inPoint).toBe(0);
    expect(layerTimingOperations(trimmed, layers, "trim-in")[0].type).toBe("setLayerTiming");
  });
  it("maps keyboard commands without hijacking command-modified keys", () => {
    const input = {
      altKey: false,
      code: "BracketLeft",
      ctrlKey: false,
      key: "[",
      metaKey: false,
    };
    expect(resolveTimelineShortcut(input)).toBe("align-in");
    expect(resolveTimelineShortcut({ ...input, altKey: true })).toBe("trim-in");
    expect(resolveTimelineShortcut({ ...input, code: "KeyK", key: "k" })).toBe("next-event");
    expect(resolveTimelineShortcut({ ...input, ctrlKey: true })).toBeUndefined();
  });

  it("keeps B/N work-area boundaries non-empty and moves the range as a unit", () => {
    expect(setWorkAreaBoundary({ start: 1, end: 3 }, "start", 4, 10, frame)).toEqual({
      start: 4,
      end: 4 + frame,
    });
    expect(setWorkAreaBoundary({ start: 3, end: 6 }, "end", 2, 10, frame)).toEqual({
      start: 2 - frame,
      end: 2,
    });
    expect(moveWorkArea({ start: 2, end: 5 }, 9, 10, frame)).toEqual({ start: 7, end: 10 });
  });

  it("builds edit-point targets and applies a selected-layer move transaction", () => {
    const layers = [layer("a", 1, 3), layer("b", 2, 5), layer("target", 7, 9)];
    layers[2].transform.opacity = {
      mode: "animated",
      keyframes: [{ id: "key-target", time: 7.5, value: 50, interpolation: "linear" }],
    };
    const composition = {
      duration: 12,
      frameRate: { numerator: 30, denominator: 1 },
      layers,
    } as Composition;
    const targets = buildTimelineSnapTargets(composition, 6, { start: 0, end: 12 });
    expect(targets).toContainEqual({ id: "target", time: 7, kind: "layer-in" });
    expect(targets).toContainEqual({ id: "key-target", time: 7.5, kind: "keyframe" });
    expect(excludeTimelineSnapTargets(targets, ["key-target"])).not.toContainEqual({
      id: "key-target",
      time: 7.5,
      kind: "keyframe",
    });
    expect(
      editLayerTimingGroup(layers.slice(0, 2), "a", "move", 6.96, composition, 100, targets, false),
    ).toEqual([
      { id: "a", inPoint: 7, outPoint: 9 },
      { id: "b", inPoint: 8, outPoint: 11 },
    ]);
  });

  it("keeps marquee coordinates stable while scrolling and clips the layer-label column", () => {
    const start = timelineContentPoint(500, 200, {
      left: 100,
      top: 50,
      scrollLeft: 20,
      scrollTop: 10,
    });
    const current = timelineContentPoint(200, 260, {
      left: 100,
      top: 50,
      scrollLeft: 120,
      scrollTop: 30,
    });
    expect(start).toEqual({ x: 420, y: 160 });
    expect(current).toEqual({ x: 220, y: 240 });
    expect(timelineMarqueeRect(start, current, 286)).toEqual({
      left: 286,
      top: 160,
      width: 134,
      height: 80,
    });
  });
});

function layer(id: string, inPoint: number, outPoint: number): Layer {
  const value = (constant: number) => ({ mode: "static" as const, value: constant });
  return {
    id,
    inPoint,
    outPoint,
    effects: [],
    transform: {
      position: [value(0), value(0), value(0)],
      rotation: [value(0), value(0), value(0)],
      scale: [value(100), value(100), value(100)],
      opacity: value(100),
    },
  } as unknown as Layer;
}
