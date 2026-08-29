import { describe, expect, it } from "vitest";
import { createLayerForComposition } from "../../core/layer-factory";
import { activeComposition, createDemoProject } from "../../core/project";
import type { Animatable } from "../../core/types";
import {
  collectAnimatedGraphTracks,
  graphCurveRange,
  graphDraggedKeyframeValue,
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

  it("uses the graph sampling pixel budget and includes Bezier overshoot in visible range", () => {
    const composition = activeComposition(createDemoProject());
    const layer = createLayerForComposition("shape", composition);
    layer.transform.rotation[2] = animated(0, 100, [0.25, 1.8, 0.75, 1.8]);
    const [track] = collectAnimatedGraphTracks(layer);

    const narrow = sampleGraphTrack(track, "value", 0, 1, 40);
    const wide = sampleGraphTrack(track, "value", 0, 1, 400);
    expect(narrow.samples.count).toBe(41);
    expect(wide.samples.count).toBe(401);
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
