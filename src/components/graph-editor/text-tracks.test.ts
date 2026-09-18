import { describe, expect, it } from "vitest";
import { createLayerForComposition } from "../../core/layers/layer-factory";
import { createBlankProject } from "../../core/project/project";
import type { Animatable } from "../../core/types";
import {
  collectAnimatedGraphTracks,
  constrainGraphTrackValue,
  graphTracksForType,
  resolveGraphType,
  sampleGraphTrack,
} from "./model";

const animated = (id: string, start: number, end: number): Animatable => ({
  mode: "animated",
  keyframes: [
    { id: `${id}-start`, time: 0, value: start, interpolation: "linear" },
    { id: `${id}-end`, time: 1, value: end, interpolation: "linear" },
  ],
});

describe("text animator graph tracks", () => {
  it("folds per-character Position into speed while preserving selector value tracks", () => {
    const project = createBlankProject(true);
    const layer = createLayerForComposition("text", project.compositions[0]);
    const animator = layer.textAnimator?.groups[0];
    const selector = animator?.selectors[0];
    if (!animator || !selector || selector.kind !== "range")
      throw new Error("Expected range text animator");
    animator.name = "Fly In";
    selector.name = "Characters";
    animator.properties.position = [
      animated("x", 0, 3),
      animated("y", 0, 4),
      { mode: "static", value: 0 },
    ];
    animator.properties.opacity = animated("opacity", 100, 0);
    selector.end = animated("end", 0, 100);

    const tracks = collectAnimatedGraphTracks(layer);
    const visible = graphTracksForType(tracks, "auto");
    const position = visible.find((track) => track.id.includes(":property:position:0"));
    const end = visible.find((track) => track.id.endsWith(":end"));
    expect(tracks.filter((track) => track.id.includes(":property:position:"))).toHaveLength(2);
    expect(position).toMatchObject({
      source: "transform",
      labelKey: "text.property.position",
      labelPrefix: "Fly In",
      labelSuffix: "X",
      minimum: -8192,
      maximum: 8192,
    });
    expect(position && resolveGraphType("auto", position)).toBe("speed");
    expect(position && sampleGraphTrack(position, "auto", 0, 1, 32).samples.speeds[16]).toBeCloseTo(
      5,
      8,
    );
    expect(end).toMatchObject({
      source: "transform",
      labelKey: "text.selector.end",
      labelPrefix: "Fly In · Characters",
      unit: "%",
      minimum: -1_000_000,
      maximum: 1_000_000,
    });
    expect(end && resolveGraphType("auto", end)).toBe("value");
    expect(end && constrainGraphTrackValue(end, 1_500_000)).toBe(1_000_000);
  });
});
