export type Id = string;

export interface Keyframe {
  id: Id;
  time: number;
  value: number;
  interpolation: "linear" | "step" | "bezier";
  easing?: [number, number, number, number];
}

export type Animatable =
  | { mode: "static"; value: number }
  | { mode: "animated"; keyframes: Keyframe[] };

export interface Transform {
  position: [Animatable, Animatable, Animatable];
  rotation: [Animatable, Animatable, Animatable];
  scale: [Animatable, Animatable, Animatable];
  anchor: [Animatable, Animatable, Animatable];
  opacity: Animatable;
}

export type LayerKind =
  | "shape"
  | "text"
  | "image"
  | "video"
  | "mesh"
  | "particle"
  | "precomposition"
  | "camera"
  | "light";
export type BlendMode = "normal" | "add" | "multiply" | "screen" | "overlay";

export interface Lut3dResource {
  kind: "lut3d";
  name: string;
  title?: string;
  size: number;
  data: number[];
  domainMin: [number, number, number];
  domainMax: [number, number, number];
  checksum: string;
}

export interface Effect {
  id: Id;
  type: string;
  name: string;
  enabled: boolean;
  parameters: Record<string, number>;
  parameterKeyframes?: Record<string, Keyframe[]>;
  resource?: Lut3dResource;
  mask?: EffectMask;
}

export interface EffectMask {
  shape: "ellipse" | "rectangle";
  center: [number, number];
  size: [number, number];
  feather: number;
  opacity: number;
  invert: boolean;
}

export interface Layer {
  id: Id;
  name: string;
  kind: LayerKind;
  parentId?: Id;
  visible: boolean;
  solo: boolean;
  locked: boolean;
  audioEnabled?: boolean;
  threeDimensional: boolean;
  inPoint: number;
  outPoint: number;
  timeOffset?: number;
  timeStretch?: number;
  timeRemap?: Animatable;
  blendMode: BlendMode;
  color: [number, number, number, number];
  size: [number, number];
  text?: string;
  asset?: {
    name: string;
    mimeType: string;
    dataUrl: string;
    width: number;
    height: number;
    duration?: number;
  };
  sourceCompositionId?: Id;
  expressions?: Record<string, string>;
  transform: Transform;
  effects: Effect[];
  material?: Material3d;
  light?: LightSettings;
  camera?: CameraSettings;
  mesh?: MeshAsset;
  particle?: ParticleSettings;
}

export interface Material3d {
  metallic: number;
  roughness: number;
  emissive: number;
}

export interface LightSettings {
  kind: "directional" | "point" | "spot";
  intensity: number;
  range: number;
  coneAngle: number;
}

export interface CameraSettings {
  projection: "perspective" | "orthographic";
  fieldOfView: number;
  orthographicSize: number;
}

export interface MeshAsset {
  name: string;
  positions: number[];
  normals: number[];
  uvs: number[];
  indices: number[];
}

export interface ParticleSettings {
  count: number;
  seed: number;
  lifetime: number;
  speed: number;
  acceleration: number;
  startSize: number;
  endSize: number;
}

export interface Composition {
  id: Id;
  name: string;
  width: number;
  height: number;
  frameRate: { numerator: number; denominator: number };
  duration: number;
  background: [number, number, number, number];
  layers: Layer[];
}

export interface Project {
  schemaVersion: 0;
  id: Id;
  name: string;
  activeCompositionId: Id;
  compositions: Composition[];
  updatedAt: string;
}

export interface EvaluatedTransform {
  position: [number, number, number];
  rotation: [number, number, number];
  scale: [number, number, number];
  anchor: [number, number, number];
  opacity: number;
}

export interface RendererMetrics {
  fps: number;
  frameMs: number;
  cpuMs: number;
  gpuMs?: number;
  drawCalls: number;
  passCount: number;
  dirtyNodes: number;
  cacheHitRate: number;
  estimatedVramMb: number;
  transientTextureCount: number;
  passTimings?: GpuPassTimings;
}

export interface GpuPassTimings {
  computeMs: number;
  shadowMs: number;
  sceneMs: number;
  postMs: number;
}

export interface GpuDiagnostics {
  available: boolean;
  adapter: string;
  architecture: string;
  description: string;
  maxTextureSize: number;
  timestampQueries: boolean;
}

export const createId = (): Id => crypto.randomUUID();

export const staticValue = (value: number): Animatable => ({ mode: "static", value });

export const createTransform = (position: [number, number, number]): Transform => ({
  position: position.map(staticValue) as Transform["position"],
  rotation: [staticValue(0), staticValue(0), staticValue(0)],
  scale: [staticValue(100), staticValue(100), staticValue(100)],
  anchor: [staticValue(0), staticValue(0), staticValue(0)],
  opacity: staticValue(100),
});
