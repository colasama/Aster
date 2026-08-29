import { getProperty, type PropertyPath } from "../core/operations";
import { evaluateAnimatable } from "../core/timeline";
import type { Animatable, Effect, Keyframe, Layer } from "../core/types";
import { EFFECT_BY_TYPE } from "../effects/registry";
import type { EffectParameterDefinition } from "../effects/types";
import type { PlainMessageKey } from "../i18n/core";

export type KeyframeTimePreview = Readonly<Record<string, number>>;

export interface TransformTimelinePropertyTrack {
  source: "transform";
  id: PropertyPath;
  path: PropertyPath;
  labelKey: PlainMessageKey;
  property: Animatable;
  step: number;
  unit: string;
}

export interface EffectTimelinePropertyTrack {
  source: "effect";
  id: string;
  effectId: string;
  effectName: string;
  parameter: string;
  definition: EffectParameterDefinition;
  keyframes: Keyframe[];
  staticValue: number;
}

export type TimelinePropertyTrack = TransformTimelinePropertyTrack | EffectTimelinePropertyTrack;

export interface TimelinePropertyGroup {
  id: string;
  label: string;
  labelKey?: PlainMessageKey;
  source: TimelinePropertyTrack["source"];
  tracks: TimelinePropertyTrack[];
}

const TRANSFORM_TRACKS: ReadonlyArray<{
  path: PropertyPath;
  labelKey: PlainMessageKey;
  step: number;
  unit: string;
}> = [
  {
    path: "position.0",
    labelKey: "timeline.property.positionX",
    step: 0.1,
    unit: "px",
  },
  {
    path: "position.1",
    labelKey: "timeline.property.positionY",
    step: 0.1,
    unit: "px",
  },
  {
    path: "position.2",
    labelKey: "timeline.property.positionZ",
    step: 0.1,
    unit: "px",
  },
  {
    path: "rotation.0",
    labelKey: "timeline.property.rotationX",
    step: 0.1,
    unit: "°",
  },
  {
    path: "rotation.1",
    labelKey: "timeline.property.rotationY",
    step: 0.1,
    unit: "°",
  },
  {
    path: "rotation.2",
    labelKey: "timeline.property.rotationZ",
    step: 0.1,
    unit: "°",
  },
  {
    path: "scale.0",
    labelKey: "timeline.property.scaleX",
    step: 0.1,
    unit: "%",
  },
  {
    path: "scale.1",
    labelKey: "timeline.property.scaleY",
    step: 0.1,
    unit: "%",
  },
  {
    path: "scale.2",
    labelKey: "timeline.property.scaleZ",
    step: 0.1,
    unit: "%",
  },
  {
    path: "opacity",
    labelKey: "timeline.property.opacity",
    step: 1,
    unit: "%",
  },
];

const CAMERA_TRACKS: ReadonlyArray<{
  path: PropertyPath;
  labelKey: PlainMessageKey;
  step: number;
  unit: string;
}> = [
  {
    path: "camera.pointOfInterest.0",
    labelKey: "timeline.property.pointOfInterestX",
    step: 0.1,
    unit: "px",
  },
  {
    path: "camera.pointOfInterest.1",
    labelKey: "timeline.property.pointOfInterestY",
    step: 0.1,
    unit: "px",
  },
  {
    path: "camera.pointOfInterest.2",
    labelKey: "timeline.property.pointOfInterestZ",
    step: 0.1,
    unit: "px",
  },
  {
    path: "camera.orientation.0",
    labelKey: "timeline.property.orientationX",
    step: 0.1,
    unit: "°",
  },
  {
    path: "camera.orientation.1",
    labelKey: "timeline.property.orientationY",
    step: 0.1,
    unit: "°",
  },
  {
    path: "camera.orientation.2",
    labelKey: "timeline.property.orientationZ",
    step: 0.1,
    unit: "°",
  },
];

export function collectTimelinePropertyGroups(layer: Layer): TimelinePropertyGroup[] {
  const groups: TimelinePropertyGroup[] = [];
  if (layer.kind !== "adjustment") {
    groups.push({
      id: "transform",
      label: "Transform",
      labelKey: "timeline.layer.transform",
      source: "transform",
      tracks: TRANSFORM_TRACKS.map((definition) => ({
        source: "transform",
        id: definition.path,
        path: definition.path,
        labelKey: definition.labelKey,
        property: getProperty(layer, definition.path),
        step: definition.step,
        unit: definition.unit,
      })),
    });
  }

  if (layer.camera) {
    groups.push({
      id: "camera",
      label: "Camera Options",
      labelKey: "timeline.layer.cameraOptions",
      source: "transform",
      tracks: CAMERA_TRACKS.map((definition) => ({
        source: "transform",
        id: definition.path,
        path: definition.path,
        labelKey: definition.labelKey,
        property: getProperty(layer, definition.path),
        step: definition.step,
        unit: definition.unit,
      })),
    });
  }

  for (const effect of layer.effects) {
    const tracks = collectEffectTimelineTracks(effect);
    if (!tracks.length) continue;
    groups.push({
      id: `effect:${effect.id}`,
      label: effect.name,
      source: "effect",
      tracks,
    });
  }
  return groups;
}

export function timelineTrackKeyframes(track: TimelinePropertyTrack): Keyframe[] {
  return track.source === "transform"
    ? track.property.mode === "animated"
      ? track.property.keyframes
      : []
    : track.keyframes;
}

export function evaluateTimelinePropertyTrack(
  track: TimelinePropertyTrack,
  time: number,
  preview?: KeyframeTimePreview,
): number {
  const keyframes = timelineTrackKeyframes(track);
  if (keyframes.length) {
    return evaluateAnimatable(
      {
        mode: "animated",
        keyframes: previewKeyframeTimes(keyframes, preview),
      },
      time,
    );
  }
  return track.source === "transform"
    ? evaluateAnimatable(track.property, time)
    : track.staticValue;
}

export function previewKeyframeTimes(
  keyframes: Keyframe[],
  preview?: KeyframeTimePreview,
): Keyframe[] {
  if (!preview) return keyframes;
  return keyframes
    .map((keyframe) => {
      const time = preview[keyframe.id];
      return time === undefined ? keyframe : { ...keyframe, time };
    })
    .sort((left, right) => left.time - right.time);
}

function collectEffectTimelineTracks(effect: Effect): EffectTimelinePropertyTrack[] {
  const registered = EFFECT_BY_TYPE.get(effect.type)?.parameters ?? [];
  const definitions = new Map(registered.map((definition) => [definition.key, definition]));
  const keys = new Set([
    ...registered.map((definition) => definition.key),
    ...Object.keys(effect.parameters),
    ...Object.keys(effect.parameterKeyframes ?? {}),
  ]);
  return [...keys].flatMap((parameter) => {
    const definition = definitions.get(parameter) ?? fallbackDefinition(effect, parameter);
    if (definition.kind === "texture") return [];
    return [
      {
        source: "effect" as const,
        id: `${effect.id}:${parameter}`,
        effectId: effect.id,
        effectName: effect.name,
        parameter,
        definition,
        keyframes: effect.parameterKeyframes?.[parameter] ?? [],
        staticValue: effect.parameters[parameter] ?? definition.defaultValue,
      },
    ];
  });
}

function fallbackDefinition(effect: Effect, parameter: string): EffectParameterDefinition {
  return {
    key: parameter,
    label: parameter
      .replace(/([A-Z])/g, " $1")
      .replace(/^./, (character) => character.toUpperCase()),
    kind: "number",
    defaultValue: effect.parameters[parameter] ?? 0,
    step: 0.1,
  };
}
