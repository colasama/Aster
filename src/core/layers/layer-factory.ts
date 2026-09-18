import { createDefaultTextAnimator } from "../animation/text-animator";
import {
  createDefaultCameraSettings,
  createDefaultCameraTransform,
} from "../scene/camera-settings";
import type { Composition, Layer, LayerKind, SceneGeneratorInstance } from "../types";
import { createId, createTransform } from "../types";
import { createCanonicalAdjustmentTransform } from "./adjustment-layer";
import { MAX_SOLID_DIMENSION } from "./solid-layer";

export type StandardLayerKind = Exclude<LayerKind, "generator">;

const names: Record<LayerKind, string> = {
  null: "Null Object",
  solid: "Solid Layer",
  audio: "Audio Layer",
  shape: "Shape Layer",
  text: "New Text",
  image: "Image Layer",
  video: "Video Layer",
  mesh: "3D Layer",
  generator: "Scene Generator",
  precomposition: "Precomposition",
  adjustment: "Adjustment Layer",
  camera: "Camera",
  light: "Light",
};

export function createLayerForComposition(
  kind: StandardLayerKind,
  composition: Composition,
  currentTime = 0,
): Layer {
  return createLayer(kind, composition, currentTime);
}

export function createGeneratorLayerForComposition(
  composition: Composition,
  generator: SceneGeneratorInstance,
  currentTime = 0,
  name = "Scene Generator",
): Layer {
  return { ...createLayer("generator", composition, currentTime), name, generator };
}

function createLayer(kind: LayerKind, composition: Composition, currentTime: number): Layer {
  const isCamera = kind === "camera";
  const isText = kind === "text";
  const isAdjustment = kind === "adjustment";
  const hasAudio = kind === "audio" || kind === "video";
  const solid =
    kind === "solid"
      ? {
          width: Math.min(composition.width, MAX_SOLID_DIMENSION),
          height: Math.min(composition.height, MAX_SOLID_DIMENSION),
          color: [0.3, 0.55, 1, 1] as const,
        }
      : undefined;
  const size: [number, number] =
    kind === "audio" || isCamera
      ? [0, 0]
      : solid
        ? [solid.width, solid.height]
        : isAdjustment
          ? [composition.width, composition.height]
          : isText
            ? [1200, 260]
            : kind === "null"
              ? [100, 100]
              : [720, 720];
  return {
    id: createId(),
    name: names[kind],
    kind,
    text: isText ? "NEW TEXT" : undefined,
    visible: kind !== "audio",
    solo: false,
    locked: false,
    motionBlur: false,
    audioEnabled: hasAudio || kind === "precomposition" ? true : undefined,
    audio: hasAudio ? { levelsDb: [0, 0], pan: 0, muted: false, reversed: false } : undefined,
    threeDimensional: kind === "mesh" || kind === "camera" || kind === "light",
    collapseTransformations: kind === "precomposition" ? false : undefined,
    inPoint: currentTime,
    outPoint: composition.duration,
    blendMode: "normal",
    color: solid
      ? [...solid.color]
      : isAdjustment
        ? [0, 0, 0, 0]
        : isText
          ? [0.95, 0.97, 1, 1]
          : kind === "null"
            ? [0, 0, 0, 0]
            : kind === "precomposition"
              ? [1, 1, 1, 1]
              : [0.3, 0.55, 1, 1],
    size,
    transform: isAdjustment
      ? createCanonicalAdjustmentTransform(composition)
      : isCamera
        ? createDefaultCameraTransform(composition.width, composition.height)
        : createTransform(
            [composition.width / 2, composition.height / 2, 0],
            [size[0] * 0.5, size[1] * 0.5, 0],
          ),
    effects: [],
    solid: solid ? { ...solid, color: [...solid.color] } : undefined,
    material:
      kind === "mesh"
        ? {
            metallic: 0.18,
            roughness: 0.42,
            emissive: 0,
            alphaMode: "opaque",
            alphaCutoff: 0.5,
          }
        : undefined,
    light:
      kind === "light"
        ? {
            kind: "directional",
            intensity: 2.5,
            range: 2400,
            coneAngle: 45,
            shadowQuality: "medium",
          }
        : undefined,
    camera:
      kind === "camera"
        ? createDefaultCameraSettings(composition.width, composition.height)
        : undefined,
    shape:
      kind === "shape"
        ? {
            kind: "rectangle",
            roundness: 0,
            strokeWidth: 0,
            strokeColor: [1, 1, 1, 1],
            fillMode: "solid",
            gradientColor: [0.2, 0.45, 1, 1],
            gradientAngle: 0,
            dashLength: 0,
            dashGap: 0,
            lineCap: "round",
            lineJoin: "round",
          }
        : undefined,
    textStyle:
      kind === "text"
        ? {
            fontFamily: "Inter, Segoe UI, sans-serif",
            fontSize: 144,
            fontWeight: 700,
            alignment: "center",
            tracking: 12,
            leading: 172,
            strokeWidth: 0,
            strokeColor: [0, 0, 0, 1],
          }
        : undefined,
    textAnimator: kind === "text" ? createDefaultTextAnimator(true) : undefined,
  };
}
