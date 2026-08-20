import {
  type Composition,
  createId,
  createTransform,
  type Layer,
  type Project,
  staticValue,
} from "./types";

function layer(base: Pick<Layer, "name" | "kind" | "color" | "size"> & Partial<Layer>): Layer {
  return {
    id: createId(),
    parentId: undefined,
    visible: true,
    solo: false,
    locked: false,
    threeDimensional: false,
    inPoint: 0,
    outPoint: 12,
    blendMode: "normal",
    transform: createTransform([1920, 1080, 0]),
    effects: [],
    ...base,
  };
}

export function createDemoProject(): Project {
  const compositionId = createId();
  const background = layer({
    name: "Deep Space Gradient",
    kind: "shape",
    color: [0.025, 0.035, 0.085, 1],
    size: [3840, 2160],
  });
  const orb = layer({
    name: "Luminous Orb",
    kind: "shape",
    color: [0.18, 0.42, 1, 1],
    size: [980, 980],
    blendMode: "screen",
    transform: createTransform([2740, 950, 80]),
    effects: [
      {
        id: createId(),
        type: "glow",
        name: "Glow",
        enabled: true,
        parameters: { radius: 96, intensity: 1.8 },
      },
    ],
  });
  const ribbon = layer({
    name: "Energy Ribbon",
    kind: "shape",
    color: [0.53, 0.24, 1, 0.86],
    size: [2350, 180],
    threeDimensional: true,
    transform: createTransform([1870, 1450, 40]),
    effects: [
      {
        id: createId(),
        type: "chromatic",
        name: "Chromatic Aberration",
        enabled: true,
        parameters: { amount: 8 },
      },
    ],
  });
  ribbon.transform.rotation[2] = staticValue(-10);
  const subtitle = layer({
    name: "Subtitle",
    kind: "text",
    text: "GPU-FIRST MOTION SYSTEM",
    color: [0.58, 0.68, 0.92, 1],
    size: [1440, 120],
    transform: createTransform([1230, 1300, 0]),
  });
  const title = layer({
    name: "ASTER",
    kind: "text",
    text: "ASTER",
    color: [0.95, 0.97, 1, 1],
    size: [2100, 560],
    transform: createTransform([1440, 960, 0]),
    effects: [
      {
        id: createId(),
        type: "exposure",
        name: "Exposure",
        enabled: true,
        parameters: { exposure: 0.35 },
      },
      {
        id: createId(),
        type: "glow",
        name: "Selective Glow",
        enabled: true,
        parameters: { radius: 42, intensity: 0.7 },
      },
    ],
  });
  title.transform.position[1] = {
    mode: "animated",
    keyframes: [
      { id: createId(), time: 0, value: 1280, interpolation: "bezier", easing: [0.16, 1, 0.3, 1] },
      {
        id: createId(),
        time: 1.25,
        value: 900,
        interpolation: "bezier",
        easing: [0.16, 1, 0.3, 1],
      },
      { id: createId(), time: 8.5, value: 900, interpolation: "bezier", easing: [0.7, 0, 0.84, 0] },
      { id: createId(), time: 10, value: 600, interpolation: "linear" },
    ],
  };
  title.transform.opacity = {
    mode: "animated",
    keyframes: [
      { id: createId(), time: 0, value: 0, interpolation: "bezier", easing: [0.16, 1, 0.3, 1] },
      { id: createId(), time: 0.8, value: 100, interpolation: "linear" },
      { id: createId(), time: 9, value: 100, interpolation: "linear" },
      { id: createId(), time: 10, value: 0, interpolation: "linear" },
    ],
  };
  const particles = layer({
    name: "GPU Particles · 100K",
    kind: "particle",
    color: [0.5, 0.74, 1, 0.65],
    size: [3840, 2160],
    blendMode: "add",
  });
  const camera = layer({
    name: "Camera 1",
    kind: "camera",
    color: [1, 1, 1, 1],
    size: [0, 0],
    threeDimensional: true,
    visible: false,
    camera: { projection: "perspective", fieldOfView: 50, orthographicSize: 2160 },
  });
  const composition: Composition = {
    id: compositionId,
    name: "Main · 4K",
    width: 3840,
    height: 2160,
    frameRate: { numerator: 60, denominator: 1 },
    duration: 12,
    background: [0.008, 0.01, 0.025, 1],
    layers: [title, subtitle, ribbon, orb, particles, background, camera],
  };
  return {
    schemaVersion: 0,
    id: createId(),
    name: "Aster Launch",
    activeCompositionId: compositionId,
    compositions: [composition],
    updatedAt: new Date().toISOString(),
  };
}

export function createBlankComposition(name = "Composition 1"): Composition {
  const compositionId = createId();
  const background = layer({
    name: "Background",
    kind: "shape",
    color: [0.015, 0.018, 0.028, 1],
    size: [1920, 1080],
    outPoint: 10,
    transform: createTransform([960, 540, 0]),
  });
  return {
    id: compositionId,
    name,
    width: 1920,
    height: 1080,
    frameRate: { numerator: 30, denominator: 1 },
    duration: 10,
    background: [0.008, 0.01, 0.018, 1],
    layers: [background],
  };
}

export function createBlankProject(): Project {
  const composition = createBlankComposition();
  return {
    schemaVersion: 0,
    id: createId(),
    name: "Untitled Project",
    activeCompositionId: composition.id,
    compositions: [composition],
    updatedAt: new Date().toISOString(),
  };
}

export function activeComposition(project: Project): Composition {
  return (
    project.compositions.find((composition) => composition.id === project.activeCompositionId) ??
    project.compositions[0]
  );
}
