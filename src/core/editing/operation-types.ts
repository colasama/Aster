import type { TextAnimatorPropertyPath } from "../animation/text-animator-property-paths";

import type { ShapeGraph } from "../layers/shape-graph";

import type { PrecompositionPlan } from "../project/precomposition";

import type { ProjectFont } from "../project/project-fonts";

import type { ClonerSettings } from "../scene/cloner";

import type {
  Animatable,
  AudioLayerSettings,
  BlendMode,
  CameraSettings,
  Composition,
  Effect,
  EffectMask,
  EnvironmentLighting,
  FootageSource,
  Id,
  Keyframe,
  Layer,
  LightSettings,
  Lut3dResource,
  Material3d,
  MotionBlurSettings,
  ProjectFolder,
  SceneGeneratorInstance,
  ShapeSettings,
  SolidSettings,
  SourceInterpretation,
  TextAnimatorSettings,
  TextStyle,
} from "../types";

export type PropertyPath =
  | "position.0"
  | "position.1"
  | "position.2"
  | "rotation.0"
  | "rotation.1"
  | "rotation.2"
  | "scale.0"
  | "scale.1"
  | "scale.2"
  | "anchor.0"
  | "anchor.1"
  | "anchor.2"
  | "camera.pointOfInterest.0"
  | "camera.pointOfInterest.1"
  | "camera.pointOfInterest.2"
  | "camera.orientation.0"
  | "camera.orientation.1"
  | "camera.orientation.2"
  | "camera.zoom"
  | "camera.filmSize"
  | "camera.orthographicSize"
  | "camera.focusDistance"
  | "camera.aperture"
  | "camera.blurLevel"
  | "camera.focusAreaWidth"
  | "camera.nearBlurLevel"
  | "camera.farBlurLevel"
  | "camera.irisRotation"
  | "camera.irisRoundness"
  | "camera.irisAspectRatio"
  | "camera.irisDiffractionFringe"
  | "camera.highlightGain"
  | "camera.highlightThreshold"
  | "camera.highlightSaturation"
  | "shape.morphProgress"
  | "opacity"
  | TextAnimatorPropertyPath;

export type Operation =
  | { type: "addProjectFont"; font: ProjectFont }
  | { type: "removeProjectFont"; fontId: string }
  | { type: "setActiveComposition"; compositionId: Id }
  | { type: "addComposition"; composition: Composition; activate: boolean }
  | { type: "addProjectFolder"; folder: ProjectFolder }
  | { type: "renameProjectItem"; itemId: Id; name: string }
  | { type: "moveProjectItem"; itemId: Id; folderId?: Id }
  | { type: "moveProjectFolder"; folderId: Id; parentId?: Id }
  | { type: "removeProjectFolder"; folderId: Id }
  | { type: "removeComposition"; compositionId: Id }
  | {
      type: "setCompositionSettings";
      compositionId: Id;
      name: string;
      width: number;
      height: number;
      frameRate: { numerator: number; denominator: number };
      duration: number;
    }
  | {
      type: "setCompositionEnvironment";
      compositionId: Id;
      environment?: EnvironmentLighting;
    }
  | {
      type: "setCompositionMotionBlur";
      compositionId: Id;
      motionBlur: MotionBlurSettings;
    }
  | {
      type: "setCompositionWorkArea";
      compositionId: Id;
      start: number;
      end: number;
    }
  | ({ type: "precomposeLayers" } & PrecompositionPlan)
  | { type: "addSource"; source: FootageSource }
  | { type: "removeSource"; sourceId: Id }
  | { type: "cleanupOrphanSources" }
  | { type: "addLayer"; layer: Layer }
  | { type: "removeLayer"; layerId: Id }
  | { type: "renameLayer"; layerId: Id; name: string }
  | { type: "reorderLayer"; layerId: Id; index: number }
  | { type: "setBlendMode"; layerId: Id; blendMode: BlendMode }
  | { type: "setParent"; layerId: Id; parentId?: Id }
  | { type: "setLayerTiming"; layerId: Id; inPoint: number; outPoint: number }
  | { type: "setLayerTimeMapping"; layerId: Id; offset: number; stretch: number }
  | { type: "setLayerTimeRemap"; layerId: Id; value?: Animatable }
  | { type: "setLayerAudioGain"; layerId: Id; gain: number }
  | { type: "setLayerAudioSettings"; layerId: Id; audio: AudioLayerSettings }
  | { type: "setMaterial3d"; layerId: Id; material: Material3d }
  | { type: "setLightSettings"; layerId: Id; light: LightSettings }
  | { type: "setLayerColor"; layerId: Id; color: Layer["color"] }
  | { type: "setSolidSettings"; layerId: Id; solid: SolidSettings }
  | { type: "setLayerSource"; layerId: Id; sourceId?: Id }
  | {
      type: "relinkSource";
      sourceId: Id;
      name: string;
      contentIdentity: string;
      dataUrl?: string;
      relativePath?: string;
      runtimeUrl?: string;
    }
  | { type: "reloadSource"; sourceId: Id; source: FootageSource }
  | { type: "interpretSource"; sourceId: Id; interpretation: SourceInterpretation }
  | { type: "setCameraSettings"; layerId: Id; camera: CameraSettings }
  | { type: "setSceneGenerator"; layerId: Id; generator: SceneGeneratorInstance }
  | { type: "setClonerSettings"; layerId: Id; cloner?: ClonerSettings }
  | { type: "setShapeSettings"; layerId: Id; shape: ShapeSettings }
  | { type: "setShapeGraph"; layerId: Id; shapeGraph?: ShapeGraph }
  | { type: "setTextContent"; layerId: Id; text: string }
  | { type: "setTextStyle"; layerId: Id; textStyle: TextStyle }
  | { type: "setTextAnimator"; layerId: Id; textAnimator: TextAnimatorSettings }
  | {
      type: "toggleLayer";
      layerId: Id;
      field: "visible" | "solo" | "locked" | "audioEnabled" | "threeDimensional" | "motionBlur";
    }
  | { type: "setProperty"; layerId: Id; path: PropertyPath; value: number }
  | { type: "addKeyframe"; layerId: Id; path: PropertyPath; keyframe: Keyframe }
  | { type: "moveKeyframe"; layerId: Id; path: PropertyPath; keyframeId: Id; time: number }
  | {
      type: "updateKeyframe";
      layerId: Id;
      path: PropertyPath;
      keyframeId: Id;
      time: number;
      value: number;
      interpolation: Keyframe["interpolation"];
      easing?: Keyframe["easing"];
      spatialIn?: number;
      spatialOut?: number;
    }
  | { type: "removeKeyframe"; layerId: Id; path: PropertyPath; keyframeId: Id }
  | { type: "easeLayer"; layerId: Id }
  | { type: "setExpression"; layerId: Id; path: PropertyPath; expression: string }
  | { type: "addEffect"; layerId: Id; effect: Effect }
  | { type: "removeEffect"; layerId: Id; effectId: Id }
  | { type: "moveEffect"; layerId: Id; effectId: Id; toIndex: number }
  | { type: "setEffectMask"; layerId: Id; effectId: Id; mask: EffectMask | undefined }
  | { type: "toggleEffect"; layerId: Id; effectId: Id }
  | { type: "setEffectLut"; layerId: Id; effectId: Id; resource?: Lut3dResource }
  | {
      type: "setEffectParameterAtTime";
      layerId: Id;
      effectId: Id;
      parameter: string;
      time: number;
      value: number;
      keyframeId: Id;
    }
  | {
      type: "addEffectParameterKeyframe";
      layerId: Id;
      effectId: Id;
      parameter: string;
      keyframe: Keyframe;
    }
  | {
      type: "removeEffectParameterKeyframe";
      layerId: Id;
      effectId: Id;
      parameter: string;
      keyframeId: Id;
    }
  | {
      type: "moveEffectParameterKeyframe";
      layerId: Id;
      effectId: Id;
      parameter: string;
      keyframeId: Id;
      time: number;
    }
  | { type: "setEffectParameter"; layerId: Id; effectId: Id; parameter: string; value: number };

export type LayerToggleField = Extract<Operation, { type: "toggleLayer" }>["field"];

export const OPERATION_TYPES = [
  "setActiveComposition",
  "addComposition",
  "addProjectFolder",
  "renameProjectItem",
  "moveProjectItem",
  "moveProjectFolder",
  "removeProjectFolder",
  "removeComposition",
  "setCompositionSettings",
  "setCompositionEnvironment",
  "setCompositionMotionBlur",
  "setCompositionWorkArea",
  "precomposeLayers",
  "addSource",
  "addProjectFont",
  "removeProjectFont",
  "removeSource",
  "cleanupOrphanSources",
  "addLayer",
  "removeLayer",
  "renameLayer",
  "reorderLayer",
  "setBlendMode",
  "setParent",
  "setLayerTiming",
  "setLayerTimeMapping",
  "setLayerTimeRemap",
  "setLayerAudioGain",
  "setLayerAudioSettings",
  "setMaterial3d",
  "setLightSettings",
  "setLayerColor",
  "setSolidSettings",
  "setLayerSource",
  "relinkSource",
  "reloadSource",
  "interpretSource",
  "setCameraSettings",
  "setSceneGenerator",
  "setClonerSettings",
  "setShapeSettings",
  "setShapeGraph",
  "setTextContent",
  "setTextStyle",
  "setTextAnimator",
  "toggleLayer",
  "setProperty",
  "addKeyframe",
  "moveKeyframe",
  "updateKeyframe",
  "removeKeyframe",
  "easeLayer",
  "setExpression",
  "addEffect",
  "removeEffect",
  "moveEffect",
  "setEffectMask",
  "toggleEffect",
  "setEffectLut",
  "setEffectParameterAtTime",
  "addEffectParameterKeyframe",
  "removeEffectParameterKeyframe",
  "moveEffectParameterKeyframe",
  "setEffectParameter",
] as const satisfies readonly Operation["type"][];

type MissingOperationType = Exclude<Operation["type"], (typeof OPERATION_TYPES)[number]>;

const operationTypeListIsExhaustive: MissingOperationType extends never ? true : false = true;

void operationTypeListIsExhaustive;
