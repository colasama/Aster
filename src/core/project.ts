import { createParticleSceneGenerator } from "./bundled-particle";
import { createDefaultCameraSettings, createDefaultCameraTransform } from "./camera-settings";
import {
  type Composition,
  createId,
  createTransform,
  type Layer,
  type Project,
  setLayerSizeAndCenterAnchor,
  staticValue,
} from "./types";

const DEMO_HDR_ENVIRONMENT =
  "data:image/vnd.radiance;base64,Iz9SQURJQU5DRQpGT1JNQVQ9MzItYml0X3JsZV9yZ2JlCgotWSAyICtYIDQK3LR4gqDI/4JkjNyCtHhQgig8ZIFGWoyBeFAygTJGboE=";
const DEMO_NORMAL_MAP =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAADsMAAA7DAcdvqGQAAAAbSURBVBhXY2ho+P//UsOd/ww2DXf+N+y78x8AZ/0L3Ki6BEgAAAAASUVORK5CYII=";

function layer(base: Pick<Layer, "name" | "kind" | "color" | "size"> & Partial<Layer>): Layer {
  const created: Layer = {
    id: createId(),
    parentId: undefined,
    visible: true,
    solo: false,
    locked: false,
    threeDimensional: false,
    motionBlur: false,
    inPoint: 0,
    outPoint: 12,
    blendMode: "normal",
    transform: createTransform([1920, 1080, 0]),
    effects: [],
    ...base,
  };
  setLayerSizeAndCenterAnchor(created, created.size);
  return created;
}

export function createDemoProject(): Project {
  const compositionId = createId();
  const background = layer({
    name: "Deep Space Gradient",
    kind: "shape",
    color: [0.025, 0.035, 0.085, 1],
    size: [3840, 2160],
    shape: {
      kind: "rectangle",
      roundness: 0,
      strokeWidth: 0,
      strokeColor: [1, 1, 1, 1],
      fillMode: "linear",
      gradientColor: [0.08, 0.025, 0.16, 1],
      gradientAngle: -18,
      dashLength: 0,
      dashGap: 0,
      lineCap: "round",
      lineJoin: "round",
    },
  });
  const orb = layer({
    name: "Luminous Orb",
    kind: "shape",
    color: [0.18, 0.42, 1, 1],
    size: [980, 980],
    shape: {
      kind: "ellipse",
      roundness: 0,
      strokeWidth: 0,
      strokeColor: [1, 1, 1, 1],
      fillMode: "radial",
      gradientColor: [0.03, 0.08, 0.3, 1],
      gradientAngle: 0,
      dashLength: 0,
      dashGap: 0,
      lineCap: "round",
      lineJoin: "round",
    },
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
    shape: {
      kind: "rectangle",
      roundness: 72,
      strokeWidth: 0,
      strokeColor: [1, 1, 1, 1],
      fillMode: "linear",
      gradientColor: [0.15, 0.65, 1, 0.86],
      gradientAngle: 0,
      dashLength: 0,
      dashGap: 0,
      lineCap: "round",
      lineJoin: "round",
    },
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
    textStyle: {
      fontFamily: "Inter, Segoe UI, sans-serif",
      fontSize: 68,
      fontWeight: 600,
      alignment: "center",
      tracking: 22,
      leading: 82,
      strokeWidth: 0,
      strokeColor: [0, 0, 0, 1],
    },
    transform: createTransform([1230, 1300, 0]),
  });
  const title = layer({
    name: "ASTER",
    kind: "text",
    text: "ASTER",
    color: [0.95, 0.97, 1, 1],
    size: [2100, 560],
    textStyle: {
      fontFamily: "Inter, Segoe UI, sans-serif",
      fontSize: 480,
      fontWeight: 800,
      alignment: "center",
      tracking: 54,
      leading: 520,
      strokeWidth: 0,
      strokeColor: [0.08, 0.12, 0.3, 1],
    },
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
    kind: "generator",
    color: [0.5, 0.74, 1, 0.65],
    size: [3840, 2160],
    blendMode: "add",
    generator: createParticleSceneGenerator(),
  });
  const materialStudy = layer({
    name: "Normal + HDR Material",
    kind: "mesh",
    color: [0.7, 0.74, 0.82, 1],
    size: [560, 560],
    threeDimensional: true,
    transform: createTransform([1900, 400, 120]),
    mesh: {
      name: "Material study quad",
      positions: [-1, -1, 0, 1, -1, 0, -1, 1, 0, 1, 1, 0],
      normals: [0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1],
      tangents: [1, 0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 1],
      uvs: [0, 1, 1, 1, 0, 0, 1, 0],
      indices: [0, 1, 2, 2, 1, 3],
      baseColor: [0.7, 0.74, 0.82, 1],
      sourceMaterial: {
        metallic: 0.55,
        roughness: 0.24,
        emissive: 0,
        alphaMode: "opaque",
        alphaCutoff: 0.5,
      },
      materialTextures: {
        normal: {
          mimeType: "image/png",
          dataUrl: DEMO_NORMAL_MAP,
          texCoord: 0,
          scale: 2,
        },
      },
    },
  });
  const camera = layer({
    name: "Camera 1",
    kind: "camera",
    color: [1, 1, 1, 1],
    size: [0, 0],
    threeDimensional: true,
    visible: true,
    transform: createDefaultCameraTransform(3840, 2160),
    camera: createDefaultCameraSettings(3840, 2160),
  });
  const composition: Composition = {
    id: compositionId,
    name: "Main · 4K",
    width: 3840,
    height: 2160,
    frameRate: { numerator: 60, denominator: 1 },
    duration: 12,
    workArea: { start: 0, end: 12 },
    background: [0.008, 0.01, 0.025, 1],
    motionBlur: {
      enabled: false,
      shutterAngle: 180,
      shutterPhase: -90,
      samplesPerFrame: 8,
      adaptiveSampleLimit: 32,
    },
    environment: {
      enabled: true,
      intensity: 0.55,
      rotation: 18,
      source: {
        name: "Aster studio gradient.hdr",
        mimeType: "image/vnd.radiance",
        dataUrl: DEMO_HDR_ENVIRONMENT,
      },
    },
    layers: [title, subtitle, ribbon, orb, materialStudy, particles, background, camera],
  };
  return {
    schemaVersion: 10,
    id: createId(),
    name: "Aster Launch",
    activeCompositionId: compositionId,
    compositions: [composition],
    sources: [],
    folders: [],
    itemFolderIds: {},
    commandLog: [],
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
    shape: {
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
    },
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
    workArea: { start: 0, end: 10 },
    background: [0.008, 0.01, 0.018, 1],
    motionBlur: {
      enabled: false,
      shutterAngle: 180,
      shutterPhase: -90,
      samplesPerFrame: 8,
      adaptiveSampleLimit: 32,
    },
    layers: [background],
  };
}

export function createBlankProject(): Project {
  const composition = createBlankComposition();
  return {
    schemaVersion: 10,
    id: createId(),
    name: "Untitled Project",
    activeCompositionId: composition.id,
    compositions: [composition],
    sources: [],
    folders: [],
    itemFolderIds: {},
    commandLog: [],
    updatedAt: new Date().toISOString(),
  };
}

export function activeComposition(project: Project): Composition {
  return (
    project.compositions.find((composition) => composition.id === project.activeCompositionId) ??
    project.compositions[0]
  );
}
