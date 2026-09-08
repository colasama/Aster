import type { ClonerSettings } from "./cloner";
import type { ProjectFont } from "./project-fonts";
import type { ShapeGraph } from "./shape-graph";
import type { TextAnimatorStackSettings } from "./text-animator-stack";

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
  | "null"
  | "solid"
  | "audio"
  | "shape"
  | "text"
  | "image"
  | "video"
  | "mesh"
  | "generator"
  | "precomposition"
  | "adjustment"
  | "camera"
  | "light";

export const LAYER_KINDS = [
  "null",
  "solid",
  "audio",
  "shape",
  "text",
  "image",
  "video",
  "mesh",
  "generator",
  "precomposition",
  "adjustment",
  "camera",
  "light",
] as const satisfies readonly LayerKind[];

export function isLayerKind(value: unknown): value is LayerKind {
  return typeof value === "string" && (LAYER_KINDS as readonly string[]).includes(value);
}
export const BLEND_MODES = [
  "normal",
  "add",
  "multiply",
  "screen",
  "overlay",
  "darken",
  "lighten",
  "color-burn",
  "color-dodge",
  "soft-light",
  "hard-light",
  "difference",
  "exclusion",
] as const;
export type BlendMode = (typeof BLEND_MODES)[number];

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
  /** Per-layer switch; the composition switch must also be enabled. */
  motionBlur: boolean;
  audioEnabled?: boolean;
  audio?: AudioLayerSettings;
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
  sourceId?: Id;
  sourceCompositionId?: Id;
  expressions?: Record<string, string>;
  transform: Transform;
  effects: Effect[];
  material?: Material3d;
  light?: LightSettings;
  camera?: CameraSettings;
  mesh?: MeshAsset;
  generator?: SceneGeneratorInstance;
  cloner?: ClonerSettings;
  shape?: ShapeSettings;
  shapeGraph?: ShapeGraph;
  textStyle?: TextStyle;
  textAnimator?: TextAnimatorSettings;
  solid?: SolidSettings;
}

export interface SolidSettings {
  width: number;
  height: number;
  color: [number, number, number, number];
}

export interface AudioLayerSettings {
  /** Independent left and right gain in decibels. */
  levelsDb: [number, number];
  /** Constant-power stereo pan from full left (-1) to full right (+1). */
  pan: number;
  muted: boolean;
  reversed: boolean;
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
  mode: "oneNode" | "twoNode";
  projection: "perspective" | "orthographic";
  /** Zoom in composition pixels. */
  zoom: Animatable;
  /** Horizontal film-back width in millimetres. */
  filmSize: Animatable;
  orthographicSize: Animatable;
  pointOfInterest: [Animatable, Animatable, Animatable];
  orientation: [Animatable, Animatable, Animatable];
  depthOfField: boolean;
  focusDistance: Animatable;
  lockFocusToZoom: boolean;
  /** Authoritative Aperture property in virtual-camera pixels. */
  aperture: Animatable;
  blurLevel: Animatable;
  focusAreaWidth: Animatable;
  nearBlurLevel: Animatable;
  farBlurLevel: Animatable;
  irisShape:
    | "fastRectangle"
    | "square"
    | "triangle"
    | "pentagon"
    | "hexagon"
    | "heptagon"
    | "octagon"
    | "nonagon"
    | "decagon"
    | "circle";
  irisRotation: Animatable;
  irisRoundness: Animatable;
  irisAspectRatio: Animatable;
  irisDiffractionFringe: Animatable;
  highlightGain: Animatable;
  highlightThreshold: Animatable;
  highlightSaturation: Animatable;
  renderQuality: number;
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

export type SceneGeneratorParameterValue = number | string | boolean | number[];

export interface SceneGeneratorInstance {
  pluginId: string;
  nodeType: string;
  apiVersion: number;
  parameters: Record<string, SceneGeneratorParameterValue>;
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
  /** Matching control-point topology, interpolated without rasterizing the path. */
  morph?: { target: BezierPath; progress: Animatable };
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

export interface TextAnimatorSettings extends TextAnimatorStackSettings {}

export interface Composition {
  id: Id;
  name: string;
  width: number;
  height: number;
  frameRate: { numerator: number; denominator: number };
  duration: number;
  workArea: { start: number; end: number };
  background: [number, number, number, number];
  motionBlur: MotionBlurSettings;
  environment?: EnvironmentLighting;
  layers: Layer[];
}

export interface MotionBlurSettings {
  enabled: boolean;
  shutterAngle: number;
  shutterPhase: number;
  samplesPerFrame: number;
  adaptiveSampleLimit: number;
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

/** A bin in the project panel. Items remain renderer-owned; this only records organization. */
export interface ProjectFolder {
  id: Id;
  name: string;
  parentId?: Id;
}

export interface Project {
  schemaVersion: 10;
  id: Id;
  name: string;
  activeCompositionId: Id;
  compositions: Composition[];
  sources: FootageSource[];
  fonts?: ProjectFont[];
  folders: ProjectFolder[];
  itemFolderIds: Record<Id, Id>;
  commandLog: ProjectCommandEntry[];
  updatedAt: string;
}

export interface SourceInterpretation {
  alpha: "straight" | "premultiplied" | "ignore";
  colorSpace: "srgb" | "linear" | "display-p3";
  frameRate?: { numerator: number; denominator: number };
}

export interface AudioStreamMetadata {
  streamIndex: number;
  channels: number;
  sampleRate: number;
}

interface FootageSourceBase {
  id: Id;
  name: string;
  mimeType: string;
  contentIdentity: string;
  dataUrl?: string;
  relativePath?: string;
  runtimeUrl?: string;
  interpretation: SourceInterpretation;
}

export type FootageSource =
  | (FootageSourceBase & { kind: "still"; width: number; height: number })
  | (FootageSourceBase & {
      kind: "video";
      width: number;
      height: number;
      duration: number;
      audio?: AudioStreamMetadata;
    })
  | (FootageSourceBase & {
      kind: "audio";
      duration: number;
      channels: number;
      sampleRate: number;
      streamIndex: number;
    })
  | (FootageSourceBase & {
      kind: "imageSequence";
      width: number;
      height: number;
      pattern: string;
      startFrame: number;
      endFrame: number;
    })
  | (FootageSourceBase & { kind: "svg"; width: number; height: number })
  | (FootageSourceBase & { kind: "psd"; width: number; height: number; layerCount: number });

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
  adjustmentLayerError?: string;
  precompositionSurfaceError?: string;
  sceneGeneratorError?: string;
  depthOfFieldTier?: -1 | 0 | 1 | 2;
  depthOfFieldDegradedReason?: string;
}

export const createId = (): Id => crypto.randomUUID();

export const staticValue = (value: number): Animatable => ({ mode: "static", value });

export const createTransform = (
  position: [number, number, number],
  anchor: [number, number, number] = [0, 0, 0],
): Transform => ({
  position: position.map(staticValue) as Transform["position"],
  rotation: [staticValue(0), staticValue(0), staticValue(0)],
  scale: [staticValue(100), staticValue(100), staticValue(100)],
  anchor: anchor.map(staticValue) as Transform["anchor"],
  opacity: staticValue(100),
});

/** Sets a layer's source size and places its transform anchor at the source center. */
export function setLayerSizeAndCenterAnchor(layer: Layer, size: [number, number]): void {
  layer.size = [...size];
  layer.transform.anchor = [staticValue(size[0] * 0.5), staticValue(size[1] * 0.5), staticValue(0)];
}
