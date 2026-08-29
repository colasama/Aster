import { describe, expect, it } from "vitest";
import { CAMERA_ANIMATABLE_FIELDS } from "../../core/camera-properties";
import { createLayerForComposition } from "../../core/layer-factory";
import { activeComposition, createDemoProject } from "../../core/project";
import type { Animatable } from "../../core/types";
import { createEffect } from "../../effects/registry";
import {
  collectAnimatedGraphTracks,
  constrainGraphTrackValue,
  easeGraphTrack,
  easingFromGraphSpeedHandle,
  graphCurveRange,
  graphDraggedKeyframeValue,
  graphSpeedSegment,
  graphTrackInterpolation,
  graphTrackKeyframesAtTime,
  graphTrackLabelKey,
  graphTrackSegmentBaseSpeed,
  graphTrackSegmentKeyframes,
  graphTracksForType,
  previewGraphTrack,
  resolveGraphType,
  sampleGraphTrack,
} from "./model";

const animated = (
  start: number,
  end: number,
  easing?: [number, number, number, number],
): Extract<Animatable, { mode: "animated" }> => ({
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
    expect(first.flatMap((track) => (track.source === "transform" ? [track.path] : []))).toEqual([
      "position.0",
      "position.2",
      "rotation.1",
      "scale.2",
      "opacity",
    ]);
    expect(first.map((track) => track.color)).toEqual(second.map((track) => track.color));
    expect(new Set(first.map((track) => track.color)).size).toBe(first.length);
    const opacity = first.find((track) => track.source === "transform" && track.path === "opacity");
    expect(opacity && constrainGraphTrackValue(opacity, -20)).toBe(0);
    expect(opacity && constrainGraphTrackValue(opacity, 140)).toBe(100);
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

  it("collects Anchor, camera pose and every exposed v9 optics track from the shared surface", () => {
    const composition = activeComposition(createDemoProject());
    const shape = createLayerForComposition("shape", composition);
    shape.transform.anchor[0] = animated(0, 3);
    shape.transform.anchor[1] = animated(0, 4);
    const anchorTracks = collectAnimatedGraphTracks(shape);
    const anchorAuto = graphTracksForType(anchorTracks, "auto");
    expect(anchorAuto).toHaveLength(1);
    expect(resolveGraphType("auto", anchorAuto[0])).toBe("speed");
    const anchorCurve = sampleGraphTrack(anchorAuto[0], "auto", 0, 1, 32);
    expect(anchorCurve.samples.speeds[Math.floor(anchorCurve.samples.count / 2)]).toBeCloseTo(5, 8);
    expect(
      graphTrackKeyframesAtTime(anchorAuto[0], 0).flatMap((target) =>
        target.source === "transform" ? [target.path] : [],
      ),
    ).toEqual(["anchor.0", "anchor.1"]);

    const camera = createLayerForComposition("camera", composition);
    expect(camera.camera).toBeDefined();
    if (!camera.camera) return;
    camera.camera.pointOfInterest[0] = animated(0, 3);
    camera.camera.pointOfInterest[1] = animated(0, 4);
    camera.camera.orientation[0] = animated(0, 90);
    for (const field of CAMERA_ANIMATABLE_FIELDS) camera.camera[field] = animated(1, 2);
    const cameraTracks = collectAnimatedGraphTracks(camera);
    const paths = cameraTracks.flatMap((track) =>
      track.source === "transform" ? [track.path] : [],
    );
    expect(paths).toEqual([
      "camera.pointOfInterest.0",
      "camera.pointOfInterest.1",
      "camera.orientation.0",
      ...CAMERA_ANIMATABLE_FIELDS.map((field) => `camera.${field}`),
    ]);
    const cameraAuto = graphTracksForType(cameraTracks, "auto");
    expect(cameraAuto.filter((track) => track.spatialProperties)).toHaveLength(1);
    const pointOfInterest = cameraAuto.find((track) => track.id === "camera.pointOfInterest.0");
    expect(
      pointOfInterest &&
        graphTrackKeyframesAtTime(pointOfInterest, 0).flatMap((target) =>
          target.source === "transform" ? [target.path] : [],
        ),
    ).toEqual(["camera.pointOfInterest.0", "camera.pointOfInterest.1"]);
    const orientation = cameraAuto.find((track) => track.id === "camera.orientation.0");
    expect(orientation).toMatchObject({
      source: "transform",
    });
    expect(orientation && resolveGraphType("auto", orientation)).toBe("value");
    const aperture = cameraTracks.find((track) => track.id === "camera.aperture");
    const threshold = cameraTracks.find((track) => track.id === "camera.highlightThreshold");
    expect(aperture && constrainGraphTrackValue(aperture, -1)).toBe(0.001);
    expect(threshold && constrainGraphTrackValue(threshold, 99)).toBe(1);
  });

  it("uses effect registry labels, units and steps without treating dynamic labels as i18n keys", () => {
    const composition = activeComposition(createDemoProject());
    const layer = createLayerForComposition("shape", composition);
    const effect = createEffect("gaussian-blur");
    effect.name = "Soft Background";
    effect.parameterKeyframes = { radius: animated(0, 100).keyframes };
    layer.effects.push(effect);

    const track = collectAnimatedGraphTracks(layer).find(
      (candidate) => candidate.source === "effect" && candidate.parameter === "radius",
    );
    expect(track).toMatchObject({
      source: "effect",
      label: "Soft Background · Blurriness",
      step: 0.5,
      unit: "px",
    });
    expect(track && graphTrackLabelKey(track, "auto")).toBeUndefined();
    expect(track && resolveGraphType("auto", track)).toBe("value");
  });

  it("quantizes discrete effects and clamps numeric and percent tracks to registry bounds", () => {
    const composition = activeComposition(createDemoProject());
    const layer = createLayerForComposition("shape", composition);
    layer.transform.position[0] = animated(0, 100);
    const blur = createEffect("gaussian-blur");
    blur.parameterKeyframes = { radius: animated(0, 100).keyframes };
    const filter = createEffect("photo-filter");
    filter.parameterKeyframes = { density: animated(0, 100).keyframes };
    const radial = createEffect("radial-blur");
    radial.parameterKeyframes = { mode: animated(0, 1).keyframes };
    layer.effects.push(blur, filter, radial);
    const tracks = collectAnimatedGraphTracks(layer);
    const position = tracks.find(
      (track) => track.source === "transform" && track.path === "position.0",
    );
    const radius = tracks.find(
      (track) =>
        track.source === "effect" && track.effectId === blur.id && track.parameter === "radius",
    );
    const density = tracks.find(
      (track) =>
        track.source === "effect" && track.effectId === filter.id && track.parameter === "density",
    );
    const mode = tracks.find(
      (track) =>
        track.source === "effect" && track.effectId === radial.id && track.parameter === "mode",
    );
    expect(position && constrainGraphTrackValue(position, 10.26)).toBe(10.26);
    expect(radius && constrainGraphTrackValue(radius, 999)).toBe(500);
    expect(radius && constrainGraphTrackValue(radius, 10.26)).toBe(10.5);
    expect(density && constrainGraphTrackValue(density, -20)).toBe(0);
    expect(density && constrainGraphTrackValue(density, 140)).toBe(100);
    expect(density && constrainGraphTrackValue(density, 44.4)).toBe(44);
    expect(mode && constrainGraphTrackValue(mode, 0.7)).toBe(1);
    expect(mode && constrainGraphTrackValue(mode, 99)).toBe(1);
    expect(mode && graphTrackInterpolation(mode, "bezier")).toBe("step");
  });

  it("combines unseparated Position dimensions into one spatial speed magnitude", () => {
    const composition = activeComposition(createDemoProject());
    const layer = createLayerForComposition("shape", composition);
    layer.transform.position[0] = animated(0, 3);
    layer.transform.position[1] = animated(0, 4);
    const tracks = collectAnimatedGraphTracks(layer);
    const autoTracks = graphTracksForType(tracks, "auto");
    const valueTracks = graphTracksForType(tracks, "value");
    const curve = sampleGraphTrack(autoTracks[0], "auto", 0, 1, 32);

    expect(autoTracks).toHaveLength(1);
    expect(valueTracks).toHaveLength(2);
    expect(autoTracks[0]?.speedLabelKey).toBe("graph.track.positionSpeed");
    expect(curve.samples.speeds[Math.floor(curve.samples.count / 2)]).toBeCloseTo(5, 8);
    expect(
      graphTrackSegmentBaseSpeed(
        autoTracks[0],
        autoTracks[0].property.keyframes[0],
        autoTracks[0].property.keyframes[1],
      ),
    ).toBeCloseTo(5, 8);
    expect(
      graphTrackSegmentKeyframes(autoTracks[0], 0, 1).flatMap((target) =>
        target.source === "transform" ? [target.path] : [],
      ),
    ).toEqual(["position.0", "position.1"]);
    expect(
      graphTrackKeyframesAtTime(autoTracks[0], 0).flatMap((target) =>
        target.source === "transform" ? [target.path] : [],
      ),
    ).toEqual(["position.0", "position.1"]);
    const previewed = previewGraphTrack(autoTracks[0], {
      trackId: autoTracks[0].id,
      keyframeId: "start",
      time: 0.25,
      value: 0,
    });
    expect(
      previewed.spatialProperties?.flatMap((property) =>
        property.mode === "animated" ? [property.keyframes[0]?.time] : [],
      ),
    ).toEqual([0.25, 0.25]);
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

  it("uses the canonical non-negative analytic speed for descending properties", () => {
    const composition = activeComposition(createDemoProject());
    const layer = createLayerForComposition("shape", composition);
    layer.transform.opacity = animated(100, 0);
    const [track] = collectAnimatedGraphTracks(layer);
    const curve = sampleGraphTrack(track, "speed", 0, 1, 32);

    for (let index = 0; index < curve.samples.count; index += 1)
      expect(curve.samples.speeds[index]).toBeCloseTo(100, 8);
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
