import type { Composition, Layer, LayerKind } from "./types";
import { createId, createTransform } from "./types";

const names: Record<LayerKind, string> = {
  shape: "Shape Layer",
  text: "New Text",
  image: "Image Layer",
  video: "Video Layer",
  mesh: "3D Layer",
  particle: "GPU Particle Layer",
  precomposition: "Precomposition",
  camera: "Camera",
  light: "Light",
};

export function createLayerForComposition(
  kind: LayerKind,
  composition: Composition,
  currentTime = 0,
): Layer {
  const isCamera = kind === "camera";
  const isText = kind === "text";
  return {
    id: createId(),
    name: names[kind],
    kind,
    text: isText ? "NEW TEXT" : undefined,
    visible: !isCamera,
    solo: false,
    locked: false,
    threeDimensional: kind === "mesh" || kind === "camera" || kind === "light",
    inPoint: currentTime,
    outPoint: composition.duration,
    blendMode: kind === "particle" ? "add" : "normal",
    color: isText ? [0.95, 0.97, 1, 1] : [0.3, 0.55, 1, 1],
    size: isCamera ? [0, 0] : isText ? [1200, 260] : [720, 720],
    transform: createTransform([composition.width / 2, composition.height / 2, 0]),
    effects: [],
    material: kind === "mesh" ? { metallic: 0.18, roughness: 0.42, emissive: 0 } : undefined,
    light:
      kind === "light"
        ? { kind: "directional", intensity: 2.5, range: 2400, coneAngle: 45 }
        : undefined,
    camera:
      kind === "camera"
        ? { projection: "perspective", fieldOfView: 50, orthographicSize: composition.height }
        : undefined,
    particle:
      kind === "particle"
        ? {
            count: 100_000,
            seed: 13_337,
            lifetime: 6,
            speed: 0.16,
            acceleration: -0.035,
            startSize: 2.4,
            endSize: 0.35,
          }
        : undefined,
    shape:
      kind === "shape"
        ? { kind: "rectangle", roundness: 0, strokeWidth: 0, strokeColor: [1, 1, 1, 1] }
        : undefined,
  };
}
