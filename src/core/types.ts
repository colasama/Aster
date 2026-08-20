import type { ClonerSettings } from "./cloner";
import type { ShapeGraph } from "./shape-graph";

export type Id = string;

export interface Keyframe {
  id: Id;
  time: number;
  value: number;
  interpolation: "linear" | "step" | "bezier";
  easing?: [number, number, number, number];
  /** Value-relative tangent for the segment entering this keyframe. */
  spatialIn?: number;
  /** Value-relative tangent for the segment leaving this keyframe. */
  spatialOut?: number;
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
  shape: "ellipse" | "rectangle" | "path";
  /** References a reusable path in the owning layer's shape graph. */
  pathId?: Id;
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
  /** Preview gain in the HTML media element's normalized 0..1 range. */
  audioGain?: number;
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
    dataUrl?: string;
    relativePath?: string;
    runtimeUrl?: string;
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
  cloner?: ClonerSettings;
  shape?: ShapeSettings;
  shapeGraph?: ShapeGraph;
  textStyle?: TextStyle;
  textAnimator?: TextAnimatorSettings;
}

export interface Material3d {
  metallic: number;
  roughness: number;
  emissive: number;
  alphaMode: "opaque" | "mask" | "blend";
  alphaCutoff: number;
}

export interface LightSettings {
  kind: "directional" | "point" | "spot";
  intensity: number;
  range: number;
  coneAngle: number;
  shadowQuality: "off" | "low" | "medium" | "high";
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
  /** xyz tangent plus the bitangent handedness in w. */
  tangents?: number[];
  uvs: number[];
  indices: number[];
  sourceMaterial?: Material3d;
  baseColor?: [number, number, number, number];
  materialTextures?: MeshMaterialTextures;
}

export interface MeshTexture {
  mimeType: "image/jpeg" | "image/png" | "image/webp";
  dataUrl: string;
  texCoord: 0;
  /** glTF normalTexture scale; omitted for color/data textures. */
  scale?: number;
}

export interface MeshMaterialTextures {
  baseColor?: MeshTexture;
  metallicRoughness?: MeshTexture;
  normal?: MeshTexture;
  emissive?: MeshTexture;
}

export interface ParticleSettings {
  count: number;
  seed: number;
  lifetime: number;
  speed: number;
  acceleration: number;
  startSize: number;
  endSize: number;
  startRotation: number;
  endRotation: number;
}

export interface BezierVertex {
  position: [number, number];
  inTangent: [number, number];
  outTangent: [number, number];
}

export interface BezierPath {
  closed: boolean;
  vertices: BezierVertex[];
}

export interface ShapeSettings {
  kind: "rectangle" | "ellipse" | "line" | "bezier";
  roundness: number;
  strokeWidth: number;
  strokeColor: [number, number, number, number];
  fillMode: "solid" | "linear" | "radial";
  gradientColor: [number, number, number, number];
  gradientAngle: number;
  dashLength: number;
  dashGap: number;
  lineCap: "butt" | "round";
  lineJoin?: "miter" | "bevel" | "round";
  path?: BezierPath;
  /** Percentage-based arc-length trim for Bezier strokes. */
  trim?: ShapeTrimSettings;
}

export interface ShapeTrimSettings {
  start: number;
  end: number;
  offset: number;
}

export interface TextStyle {
  fontFamily: string;
  fontSize: number;
  fontWeight: number;
  alignment: "left" | "center" | "right";
  tracking: number;
  leading: number;
  strokeWidth: number;
  strokeColor: [number, number, number, number];
}

export interface TextAnimatorSettings {
  enabled: boolean;
  /** Seconds before the first character begins. */
  delay: number;
  /** Additional delay in seconds for each grapheme cluster. */
  stagger: number;
  duration: number;
  /** Starting offset in text-layer pixels; animation resolves to zero. */
  position: [number, number];
  /** Starting uniform scale percentage; animation resolves to 100. */
  scale: number;
  /** Starting opacity percentage; animation resolves to 100. */
  opacity: number;
}

export interface Composition {
  id: Id;
  name: string;
  width: number;
  height: number;
  frameRate: { numerator: number; denominator: number };
  duration: number;
  background: [number, number, number, number];
  environment?: EnvironmentLighting;
  layers: Layer[];
}

export interface EnvironmentLighting {
  enabled: boolean;
  /** Linear multiplier applied before the HDR scene is tone mapped. */
  intensity: number;
  /** Horizontal equirectangular rotation in degrees. */
  rotation: number;
  source: {
    name: string;
    mimeType: "image/vnd.radiance" | "image/x-hdr";
    dataUrl: string;
  };
}

export interface ProjectCommandEntry {
  id: Id;
  at: string;
  source: "ai" | "user";
  summary: string;
  operationTypes: string[];
  /** Present only when the transaction is small enough to persist safely. */
  serializedOperations?: string;
}

export interface Project {
  schemaVersion: 1;
  id: Id;
  name: string;
  activeCompositionId: Id;
  compositions: Composition[];
  commandLog: ProjectCommandEntry[];
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
  memoryBudgetMb?: number;
  memoryPressure?: "normal" | "warning" | "critical";
  shadowMapSize?: number;
  fusedEffectCount?: number;
  fusionGroupCount?: number;
  fusionBarrierCount?: number;
  temporalCacheMb?: number;
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
  pipelineCompileMs?: number;
  prewarmedPipelines?: number;
  materialResourceError?: string;
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
