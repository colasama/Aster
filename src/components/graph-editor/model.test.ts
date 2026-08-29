import { describe, expect, it } from "vitest";
import { createLayerForComposition } from "../../core/layer-factory";
import { activeComposition, createDemoProject } from "../../core/project";
import type { Animatable } from "../../core/types";
import {
  collectAnimatedGraphTracks,
  easeGraphTrack,
  easingFromGraphSpeedHandle,
  graphCurveRange,
  graphDraggedKeyframeValue,
  graphSpeedSegment,
  previewGraphTrack,
  resolveGraphType,
  sampleGraphTrack,
} from "./model";

const animated = (
  start: number,
  end: number,
  easing?: [number, number, number, number],
): Animatable => ({
  mode: "animated",
  keyframes: [
    { id: "start", time: 0, value: start, interpolation: easing ? "bezier" : "linear", easing },
    { id: "end", time: 1, value: end, interpolation: "linear" },
  ],
});

describe("graph editor track model", () => {
  it("collects every animated transform scalar in stable path and color order", () => {
    const composition = activeComposition(createDemoProject());
    const layer = createLayerForComposition("shape", composition);
    layer.transform.position[0] = animated(0, 100);
    layer.transform.position[2] = animated(-20, 40);
    layer.transform.rotation[1] = animated(0, 90);
    layer.transform.scale[2] = animated(50, 120);
    layer.transform.opacity = animated(0, 100);

    const first = collectAnimatedGraphTracks(layer);
    const second = collectAnimatedGraphTracks(layer);
    expect(first.map((track) => track.path)).toEqual([
      "position.0",
      "position.2",
      "rotation.1",
      "scale.2",
      "opacity",
    ]);
    expect(first.map((track) => track.color)).toEqual(second.map((track) => track.color));
    expect(new Set(first.map((track) => track.color)).size).toBe(first.length);
  });

  it("auto-selects speed for Position and value for other transform properties", () => {
    const composition = activeComposition(createDemoProject());
    const layer = createLayerForComposition("shape", composition);
    layer.transform.position[0] = animated(0, 100);
    layer.transform.rotation[0] = animated(0, 100);
    const [position, rotation] = collectAnimatedGraphTracks(layer);

    expect(resolveGraphType("auto", position)).toBe("speed");
    expect(resolveGraphType("auto", rotation)).toBe("value");
    expect(resolveGraphType("speed", rotation)).toBe("speed");
  });

  it("allows value editing only on the Value Graph", () => {
    expect(graphDraggedKeyframeValue("value", 25, -40)).toBe(-40);
    expect(graphDraggedKeyframeValue("speed", 25, -40)).toBe(25);
    expect(graphDraggedKeyframeValue("value", 25, Number.NaN)).toBe(25);
  });

  it("round-trips AE speed and influence handles through temporal cubic easing", () => {
    const start = {
      id: "start",
      time: 2,
      value: 10,
      interpolation: "bezier" as const,
      easing: [0.25, 0.5, 0.7, 0.8] as [number, number, number, number],
    };
    const end = { id: "end", time: 4, value: 50, interpolation: "linear" as const };
    const initial = graphSpeedSegment(start, end);
    expect(initial.outgoingSpeed).toBeCloseTo(40);
    expect(initial.incomingSpeed).toBeCloseTo(40 / 3);
    expect(initial.outgoingInfluence).toBeCloseTo(0.25);
    expect(initial.incomingInfluence).toBeCloseTo(0.3);

    const outgoing = easingFromGraphSpeedHandle(start, end, "out", 0.4, 30);
    const incoming = easingFromGraphSpeedHandle({ ...start, easing: outgoing }, end, "in", 0.2, 50);
    const result = graphSpeedSegment({ ...start, easing: incoming }, end);
    expect(result.outgoingInfluence).toBeCloseTo(0.4);
    expect(result.outgoingSpeed).toBeCloseTo(30);
    expect(result.incomingInfluence).toBeCloseTo(0.2);
    expect(result.incomingSpeed).toBeCloseTo(50);
  });

  it("applies Easy Ease In and Out to the owning sides of adjacent segments", () => {
    const composition = activeComposition(createDemoProject());
    const layer = createLayerForComposition("shape", composition);
    layer.transform.opacity = {
      mode: "animated",
      keyframes: [
        { id: "a", time: 0, value: 0, interpolation: "linear" },
        { id: "b", time: 1, value: 50, interpolation: "linear" },
        { id: "c", time: 2, value: 100, interpolation: "linear" },
      ],
    };
    const [track] = collectAnimatedGraphTracks(layer);
    const both = easeGraphTrack(track, new Set(["b"]), "both");
    expect(both.map(({ keyframe }) => keyframe.id)).toEqual(["b", "a"]);
    expect(both.find(({ keyframe }) => keyframe.id === "b")?.easing).toEqual([1 / 3, 0, 2 / 3, 1]);
    expect(both.find(({ keyframe }) => keyframe.id === "a")?.easing).toEqual([1 / 3, 0, 2 / 3, 1]);
    expect(easeGraphTrack(track, new Set(["a"]), "in")).toEqual([]);
    expect(easeGraphTrack(track, new Set(["c"]), "out")).toEqual([]);
  });

  it("uses bounded adaptive graph sampling and includes Bezier overshoot in visible range", () => {
    const composition = activeComposition(createDemoProject());
    const layer = createLayerForComposition("shape", composition);
    layer.transform.rotation[2] = animated(0, 100, [0.25, 1.8, 0.75, 1.8]);
    const [track] = collectAnimatedGraphTracks(layer);

    const narrow = sampleGraphTrack(track, "value", 0, 1, 40);
    const wide = sampleGraphTrack(track, "value", 0, 1, 400);
    expect(narrow.samples.count).toBeGreaterThanOrEqual(41);
    expect(wide.samples.count).toBeGreaterThanOrEqual(401);
    expect(narrow.samples.count).toBeLessThan(wide.samples.count);
    const range = graphCurveRange([wide]);
    expect(range.max).toBeGreaterThan(100);
    expect(range.min).toBeLessThanOrEqual(0);
  });

  it("previews one keyframe without mutating the source track and keeps time order", () => {
    const composition = activeComposition(createDemoProject());
    const layer = createLayerForComposition("shape", composition);
    layer.transform.opacity = animated(0, 100);
    const [track] = collectAnimatedGraphTracks(layer);
    const previewed = previewGraphTrack(track, {
      trackId: track.id,
      keyframeId: "start",
      time: 0.75,
      value: 25,
    });

    expect(track.property.keyframes[0]).toMatchObject({ time: 0, value: 0 });
    expect(
      previewed.property.keyframes.map(({ id, time, value }) => ({ id, time, value })),
    ).toEqual([
      { id: "start", time: 0.75, value: 25 },
      { id: "end", time: 1, value: 100 },
    ]);
  });
});
