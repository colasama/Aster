import {
  assertAdjustmentLayerInvariants,
  createCanonicalAdjustmentTransform,
} from "./adjustment-layer";
import { layerHasAudio, linearToDecibels, normalizeAudioLayerSettings } from "./audio-layer";
import { normalizeCameraSettings } from "./camera-settings";
import { type ClonerSettings, normalizeClonerSettings } from "./cloner";
import { referencedSourceIds, sourceSupportsLayer } from "./footage-source";
import { applyPrecompositionPlan, type PrecompositionPlan } from "./precomposition";
import { activeComposition } from "./project";
import {
  assertCanAddLayer,
  assertCanUpdateLayer,
  assertLayerEffectLimits,
  assertProjectRenderBoundaries,
} from "./project-render-boundaries";
import { assertSceneGeneratorInstance } from "./scene-generator";
import type { ShapeGraph } from "./shape-graph";
import { validateShapeGraph } from "./shape-graph";
import { applySolidSettings } from "./solid-layer";
import { normalizeTextAnimatorSettings } from "./text-animator";
import { insertKeyframe } from "./timeline";
import { normalizeWorkArea } from "./timeline-editing";
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
  Project,
  ProjectFolder,
  SceneGeneratorInstance,
  ShapeSettings,
  SolidSettings,
  SourceInterpretation,
  TextAnimatorSettings,
  TextStyle,
} from "./types";
import { isLayerKind } from "./types";

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
  | "camera.pointOfInterest.0"
  | "camera.pointOfInterest.1"
  | "camera.pointOfInterest.2"
  | "camera.orientation.0"
  | "camera.orientation.1"
  | "camera.orientation.2"
  | "opacity";

export type Operation =
  | { type: "setActiveComposition"; compositionId: Id }
  | { type: "addComposition"; composition: Composition; activate: boolean }
  | { type: "addProjectFolder"; folder: ProjectFolder }
  | { type: "moveProjectItem"; itemId: Id; folderId?: Id }
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
      field: "visible" | "solo" | "locked" | "audioEnabled" | "threeDimensional";
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

export const OPERATION_TYPES = [
  "setActiveComposition",
  "addComposition",
  "addProjectFolder",
  "moveProjectItem",
  "setCompositionSettings",
  "setCompositionEnvironment",
  "setCompositionWorkArea",
  "precomposeLayers",
  "addSource",
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

export function applyOperations(project: Project, operations: Operation[]): Project {
  const next = cloneProjectSnapshot(project);
  for (const operation of operations) applyOperation(next, operation);
  next.updatedAt = new Date().toISOString();
  return next;
}

export function applyOperation(project: Project, operation: Operation): void {
  if (operation.type === "setActiveComposition") {
    if (!project.compositions.some((composition) => composition.id === operation.compositionId))
      throw new Error("Composition does not exist");
    project.activeCompositionId = operation.compositionId;
    return;
  }
  if (operation.type === "addComposition") {
    if (project.compositions.some((composition) => composition.id === operation.composition.id))
      throw new Error("Composition already exists");
    const composition = structuredClone(operation.composition);
    assertProjectRenderBoundaries({ compositions: [...project.compositions, composition] });
    project.compositions.push(composition);
    if (operation.activate) project.activeCompositionId = operation.composition.id;
    return;
  }
  if (operation.type === "addProjectFolder") {
    project.folders ??= [];
    project.itemFolderIds ??= {};
    if (project.folders.some((folder) => folder.id === operation.folder.id))
      throw new Error("Project folder already exists");
    if (
      operation.folder.parentId &&
      !project.folders.some((folder) => folder.id === operation.folder.parentId)
    )
      throw new Error("Parent project folder does not exist");
    project.folders.push({
      id: operation.folder.id,
      name: operation.folder.name.trim().slice(0, 256) || "Untitled Folder",
      ...(operation.folder.parentId ? { parentId: operation.folder.parentId } : {}),
    });
    return;
  }
  if (operation.type === "moveProjectItem") {
    project.folders ??= [];
    project.itemFolderIds ??= {};
    if (operation.folderId && !project.folders.some((folder) => folder.id === operation.folderId))
      throw new Error("Project folder does not exist");
    const itemExists =
      project.compositions.some((composition) => composition.id === operation.itemId) ||
      project.sources.some((source) => source.id === operation.itemId);
    if (!itemExists) throw new Error("Project item does not exist");
    if (operation.folderId) project.itemFolderIds[operation.itemId] = operation.folderId;
    else delete project.itemFolderIds[operation.itemId];
    return;
  }
  if (operation.type === "setCompositionSettings") {
    const composition = project.compositions.find(
      (candidate) => candidate.id === operation.compositionId,
    );
    if (!composition) throw new Error("Composition does not exist");
    composition.name = operation.name.trim().slice(0, 256) || "Untitled Composition";
    composition.width = Math.round(clamp(operation.width, 16, 16_384));
    composition.height = Math.round(clamp(operation.height, 16, 16_384));
    composition.frameRate = {
      numerator: Math.round(clamp(operation.frameRate.numerator, 1, 240_000)),
      denominator: Math.round(clamp(operation.frameRate.denominator, 1, 240_000)),
    };
    composition.duration = clamp(operation.duration, 0.1, 86_400);
    for (const layer of composition.layers) {
      if (layer.kind !== "adjustment") continue;
      layer.size = [composition.width, composition.height];
      layer.transform = createCanonicalAdjustmentTransform(composition);
    }
    composition.workArea = normalizeWorkArea(
      composition.workArea.start,
      composition.workArea.end,
      composition.duration,
      composition.frameRate.denominator / composition.frameRate.numerator,
    );
    return;
  }
  if (operation.type === "setCompositionWorkArea") {
    const composition = project.compositions.find(
      (candidate) => candidate.id === operation.compositionId,
    );
    if (!composition) throw new Error("Composition does not exist");
    composition.workArea = normalizeWorkArea(
      operation.start,
      operation.end,
      composition.duration,
      composition.frameRate.denominator / composition.frameRate.numerator,
    );
    return;
  }
  if (operation.type === "setCompositionEnvironment") {
    const composition = project.compositions.find(
      (candidate) => candidate.id === operation.compositionId,
    );
    if (!composition) throw new Error("Composition does not exist");
    if (!operation.environment) {
      composition.environment = undefined;
      return;
    }
    if (operation.environment.source.dataUrl.length > 64 * 1024 * 1024)
      throw new Error("HDR environment exceeds the 64 MiB encoded limit");
    composition.environment = {
      enabled: operation.environment.enabled,
      intensity: clamp(operation.environment.intensity, 0, 32),
      rotation: clamp(operation.environment.rotation, -1_000_000, 1_000_000),
      source: {
        name: operation.environment.source.name.trim().slice(0, 512) || "Environment.hdr",
        mimeType: operation.environment.source.mimeType,
        dataUrl: operation.environment.source.dataUrl,
      },
    };
    return;
  }
  if (operation.type === "precomposeLayers") {
    applyPrecompositionPlan(project, operation);
    return;
  }
  if (operation.type === "addSource") {
    assertOperationalSource(operation.source);
    if (project.sources.some((source) => source.id === operation.source.id))
      throw new Error("Footage source already exists");
    if (
      project.sources.some((source) => source.contentIdentity === operation.source.contentIdentity)
    )
      throw new Error("Footage source content already exists");
    project.sources.push(copySourceForOperation(operation.source));
    return;
  }
  if (operation.type === "removeSource") {
    if (referencedSourceIds(project).has(operation.sourceId))
      throw new Error("Cannot remove a footage source while layers still reference it");
    const sourceIndex = project.sources.findIndex((source) => source.id === operation.sourceId);
    if (sourceIndex < 0) throw new Error("Footage source does not exist");
    project.sources.splice(sourceIndex, 1);
    delete project.itemFolderIds[operation.sourceId];
    return;
  }
  if (operation.type === "cleanupOrphanSources") {
    const referenced = referencedSourceIds(project);
    const sourceIds = new Set(project.sources.map((source) => source.id));
    project.sources = project.sources.filter((source) => referenced.has(source.id));
    for (const itemId of Object.keys(project.itemFolderIds))
      if (sourceIds.has(itemId) && !referenced.has(itemId)) delete project.itemFolderIds[itemId];
    return;
  }
  if (
    operation.type === "relinkSource" ||
    operation.type === "reloadSource" ||
    operation.type === "interpretSource"
  ) {
    const sourceIndex = project.sources.findIndex((source) => source.id === operation.sourceId);
    if (sourceIndex < 0) throw new Error("Footage source does not exist");
    const source = project.sources[sourceIndex];
    if (operation.type === "relinkSource") {
      assertSourceLocator(
        operation.contentIdentity,
        operation.dataUrl,
        operation.relativePath,
        operation.runtimeUrl,
      );
      if (
        project.sources.some(
          (candidate) =>
            candidate.id !== source.id && candidate.contentIdentity === operation.contentIdentity,
        )
      )
        throw new Error("Footage source content already exists");
      project.sources[sourceIndex] = {
        ...source,
        name: operation.name.trim().slice(0, 512) || source.name,
        contentIdentity: operation.contentIdentity,
        dataUrl: operation.dataUrl,
        relativePath: operation.relativePath,
        runtimeUrl: operation.runtimeUrl,
      };
    } else if (operation.type === "reloadSource") {
      assertOperationalSource(operation.source);
      if (operation.source.id !== source.id || operation.source.kind !== source.kind)
        throw new Error("Reloaded footage must preserve source identity and kind");
      if (
        project.sources.some(
          (candidate) =>
            candidate.id !== source.id &&
            candidate.contentIdentity === operation.source.contentIdentity,
        )
      )
        throw new Error("Footage source content already exists");
      project.sources[sourceIndex] = copySourceForOperation(operation.source);
    } else {
      project.sources[sourceIndex] = {
        ...source,
        interpretation: normalizeSourceInterpretation(operation.interpretation),
      };
    }
    return;
  }
  const composition = activeComposition(project);
  if (operation.type === "addLayer") {
    if (composition.layers.some((layer) => layer.id === operation.layer.id))
      throw new Error("Layer already exists");
    if (!isLayerKind(operation.layer.kind)) throw new Error("Layer kind is unsupported");
    if (operation.layer.sourceId) {
      const source = project.sources.find((candidate) => candidate.id === operation.layer.sourceId);
      if (!source) throw new Error("Layer references a missing footage source");
      if (!sourceSupportsLayer(source, operation.layer))
        throw new Error(
          `${source.kind} footage is incompatible with ${operation.layer.kind} layers`,
        );
    }
    assertAdjustmentLayerInvariants(operation.layer, composition);
    assertCanAddLayer(project, composition, operation.layer);
    composition.layers.unshift(structuredClone(operation.layer));
    return;
  }
  const index = composition.layers.findIndex((layer) => layer.id === operation.layerId);
  if (index < 0) throw new Error("Layer does not exist");
  const layer = composition.layers[index];
  assertAdjustmentOperationSupported(layer, operation);
  switch (operation.type) {
    case "removeLayer":
      composition.layers.splice(index, 1);
      for (const child of composition.layers)
        if (child.parentId === operation.layerId) child.parentId = undefined;
      break;
    case "renameLayer":
      layer.name = operation.name;
      break;
    case "reorderLayer": {
      composition.layers.splice(index, 1);
      composition.layers.splice(
        Math.max(0, Math.min(composition.layers.length, operation.index)),
        0,
        layer,
      );
      break;
    }
    case "setBlendMode": {
      const nextLayer = { ...layer, blendMode: operation.blendMode };
      assertCanUpdateLayer(project, composition, nextLayer);
      layer.blendMode = nextLayer.blendMode;
      break;
    }
    case "setParent":
      validateParent(composition.layers, layer.id, operation.parentId);
      layer.parentId = operation.parentId;
      break;
    case "setLayerTiming":
      layer.inPoint = Math.max(0, operation.inPoint);
      layer.outPoint = Math.max(layer.inPoint + 1 / 240, operation.outPoint);
      break;
    case "setLayerTimeMapping":
      layer.timeOffset = Number.isFinite(operation.offset) ? Math.max(0, operation.offset) : 0;
      layer.timeStretch = Number.isFinite(operation.stretch)
        ? Math.max(0.01, operation.stretch)
        : 1;
      break;
    case "setLayerTimeRemap":
      layer.timeRemap = operation.value;
      break;
    case "setLayerAudioGain":
      if (!layerHasAudio(layer)) throw new Error("Layer does not contain audio");
      layer.audio = normalizeAudioLayerSettings({
        ...(layer.audio ?? { levelsDb: [0, 0], pan: 0, muted: false, reversed: false }),
        levelsDb: [
          linearToDecibels(clamp(operation.gain, 0, 1)),
          linearToDecibels(clamp(operation.gain, 0, 1)),
        ],
      });
      break;
    case "setLayerAudioSettings":
      if (!layerHasAudio(layer)) throw new Error("Layer does not contain audio");
      layer.audio = normalizeAudioLayerSettings(operation.audio);
      break;
    case "setMaterial3d":
      layer.material = {
        metallic: clamp01(operation.material.metallic),
        roughness: Math.max(0.04, clamp01(operation.material.roughness)),
        emissive: clamp(operation.material.emissive, 0, 16),
        alphaMode: operation.material.alphaMode,
        alphaCutoff: clamp01(operation.material.alphaCutoff),
      };
      break;
    case "setLightSettings":
      layer.light = {
        kind: operation.light.kind,
        intensity: clamp(operation.light.intensity, 0, 100),
        range: clamp(operation.light.range, 1, 100_000),
        coneAngle: clamp(operation.light.coneAngle, 1, 179),
        shadowQuality: operation.light.shadowQuality,
      };
      break;
    case "setLayerColor":
      if (layer.kind === "solid" && layer.solid)
        applySolidSettings(layer, { ...layer.solid, color: operation.color });
      else
        layer.color = operation.color.map((channel, index) =>
          clamp(channel, 0, index === 3 ? 1 : 16),
        ) as Layer["color"];
      break;
    case "setSolidSettings":
      applySolidSettings(layer, operation.solid);
      break;
    case "setLayerSource": {
      if (!operation.sourceId) {
        layer.sourceId = undefined;
        break;
      }
      const source = project.sources.find((candidate) => candidate.id === operation.sourceId);
      if (!source) throw new Error("Footage source does not exist");
      if (!sourceSupportsLayer(source, layer))
        throw new Error(`${source.kind} footage is incompatible with ${layer.kind} layers`);
      layer.sourceId = source.id;
      break;
    }
    case "setCameraSettings":
      if (layer.kind !== "camera") throw new Error("Camera settings require a camera layer");
      layer.camera = normalizeCameraSettings(
        operation.camera,
        composition.width,
        composition.height,
      );
      break;
    case "setSceneGenerator": {
      if (layer.kind !== "generator")
        throw new Error("Scene generator settings require a generator layer");
      assertSceneGeneratorInstance(operation.generator);
      const nextLayer = { ...layer, generator: structuredClone(operation.generator) };
      assertCanUpdateLayer(project, composition, nextLayer);
      layer.generator = nextLayer.generator;
      break;
    }
    case "setClonerSettings":
      {
        const nextLayer = {
          ...layer,
          cloner: operation.cloner ? normalizeClonerSettings(operation.cloner) : undefined,
        };
        assertCanUpdateLayer(project, composition, nextLayer);
        layer.cloner = nextLayer.cloner;
      }
      break;
    case "setShapeSettings":
      layer.shape = {
        kind: operation.shape.kind,
        roundness: clamp(operation.shape.roundness, 0, 100_000),
        strokeWidth: clamp(operation.shape.strokeWidth, 0, 100_000),
        strokeColor: operation.shape.strokeColor.map((channel, index) =>
          clamp(channel, 0, index === 3 ? 1 : 16),
        ) as ShapeSettings["strokeColor"],
        fillMode: operation.shape.fillMode,
        gradientColor: operation.shape.gradientColor.map((channel, index) =>
          clamp(channel, 0, index === 3 ? 1 : 16),
        ) as ShapeSettings["gradientColor"],
        gradientAngle: clamp(operation.shape.gradientAngle, -36_000, 36_000),
        dashLength: clamp(operation.shape.dashLength, 0, 100_000),
        dashGap: clamp(operation.shape.dashGap, 0, 100_000),
        lineCap: operation.shape.lineCap,
        lineJoin: operation.shape.lineJoin ?? "round",
        path: operation.shape.path ? structuredClone(operation.shape.path) : undefined,
        trim: operation.shape.trim ? structuredClone(operation.shape.trim) : undefined,
      };
      break;
    case "setShapeGraph":
      if (operation.shapeGraph) validateShapeGraph(operation.shapeGraph);
      layer.shapeGraph = operation.shapeGraph ? structuredClone(operation.shapeGraph) : undefined;
      break;
    case "setTextContent":
      layer.text = operation.text.slice(0, 20_000);
      break;
    case "setTextStyle":
      layer.textStyle = {
        fontFamily: operation.textStyle.fontFamily.trim().slice(0, 160) || "sans-serif",
        fontSize: clamp(operation.textStyle.fontSize, 1, 4096),
        fontWeight: Math.round(clamp(operation.textStyle.fontWeight, 100, 900) / 100) * 100,
        alignment: operation.textStyle.alignment,
        tracking: clamp(operation.textStyle.tracking, -1000, 1000),
        leading: clamp(operation.textStyle.leading, 1, 8192),
        strokeWidth: clamp(operation.textStyle.strokeWidth, 0, 512),
        strokeColor: operation.textStyle.strokeColor.map((channel, index) =>
          clamp(channel, 0, index === 3 ? 1 : 16),
        ) as TextStyle["strokeColor"],
      };
      break;
    case "setTextAnimator":
      layer.textAnimator = normalizeTextAnimatorSettings(operation.textAnimator);
      break;
    case "toggleLayer":
      if (operation.field === "threeDimensional") {
        const nextLayer = { ...layer, threeDimensional: !layer.threeDimensional };
        assertCanUpdateLayer(project, composition, nextLayer);
        layer.threeDimensional = nextLayer.threeDimensional;
      } else layer[operation.field] = !layer[operation.field];
      break;
    case "setProperty":
      setProperty(layer, operation.path, { mode: "static", value: operation.value });
      break;
    case "addKeyframe":
      setProperty(
        layer,
        operation.path,
        insertKeyframe(getProperty(layer, operation.path), operation.keyframe),
      );
      break;
    case "moveKeyframe": {
      const property = getProperty(layer, operation.path);
      if (property.mode !== "animated") break;
      const keyframe = property.keyframes.find((entry) => entry.id === operation.keyframeId);
      if (!keyframe) throw new Error("Keyframe does not exist");
      keyframe.time = Math.max(0, operation.time);
      property.keyframes.sort((left, right) => left.time - right.time);
      break;
    }
    case "updateKeyframe": {
      const property = getProperty(layer, operation.path);
      if (property.mode !== "animated") break;
      const keyframe = property.keyframes.find((entry) => entry.id === operation.keyframeId);
      if (!keyframe) throw new Error("Keyframe does not exist");
      const time = Math.max(0, operation.time);
      property.keyframes = property.keyframes
        .filter(
          (entry) => entry.id === operation.keyframeId || Math.abs(entry.time - time) > 0.000_001,
        )
        .map((entry) =>
          entry.id === operation.keyframeId
            ? {
                ...entry,
                time,
                value: Number.isFinite(operation.value) ? operation.value : entry.value,
                interpolation: operation.interpolation,
                easing: operation.easing,
                spatialIn: operation.spatialIn ?? entry.spatialIn,
                spatialOut: operation.spatialOut ?? entry.spatialOut,
              }
            : entry,
        )
        .sort((left, right) => left.time - right.time);
      break;
    }
    case "removeKeyframe": {
      const property = getProperty(layer, operation.path);
      if (property.mode !== "animated") break;
      const removed = property.keyframes.find((entry) => entry.id === operation.keyframeId);
      property.keyframes = property.keyframes.filter((entry) => entry.id !== operation.keyframeId);
      if (property.keyframes.length === 0)
        setProperty(layer, operation.path, { mode: "static", value: removed?.value ?? 0 });
      break;
    }
    case "easeLayer":
      easeTransform(layer);
      break;
    case "setExpression": {
      layer.expressions ??= {};
      if (operation.expression.trim())
        layer.expressions[operation.path] = operation.expression.trim();
      else delete layer.expressions[operation.path];
      break;
    }
    case "addEffect":
      assertLayerEffectLimits({ effects: [...layer.effects, operation.effect] });
      layer.effects.push(structuredClone(operation.effect));
      break;
    case "removeEffect":
      layer.effects = layer.effects.filter((effect) => effect.id !== operation.effectId);
      break;
    case "moveEffect": {
      const fromIndex = layer.effects.findIndex((effect) => effect.id === operation.effectId);
      if (fromIndex < 0) throw new Error("Effect does not exist");
      const [effect] = layer.effects.splice(fromIndex, 1);
      if (!effect) throw new Error("Effect does not exist");
      const toIndex = Math.max(0, Math.min(layer.effects.length, Math.trunc(operation.toIndex)));
      layer.effects.splice(toIndex, 0, effect);
      break;
    }
    case "setEffectMask": {
      const effect = layer.effects.find((entry) => entry.id === operation.effectId);
      if (!effect) throw new Error("Effect does not exist");
      effect.mask = operation.mask;
      break;
    }
    case "toggleEffect": {
      const effect = layer.effects.find((entry) => entry.id === operation.effectId);
      if (!effect) throw new Error("Effect does not exist");
      assertLayerEffectLimits({
        effects: layer.effects.map((entry) =>
          entry.id === operation.effectId ? { ...entry, enabled: !entry.enabled } : entry,
        ),
      });
      effect.enabled = !effect.enabled;
      break;
    }
    case "setEffectParameter": {
      const effect = layer.effects.find((entry) => entry.id === operation.effectId);
      if (!effect) throw new Error("Effect does not exist");
      effect.parameters[operation.parameter] = operation.value;
      break;
    }
    case "setEffectLut": {
      const effect = layer.effects.find((entry) => entry.id === operation.effectId);
      if (!effect) throw new Error("Effect does not exist");
      if (effect.type !== "lut") throw new Error("LUT resources require a 3D LUT effect");
      assertLayerEffectLimits(layer);
      effect.resource = operation.resource;
      break;
    }
    case "setEffectParameterAtTime": {
      const effect = layer.effects.find((entry) => entry.id === operation.effectId);
      if (!effect) throw new Error("Effect does not exist");
      const track = effect.parameterKeyframes?.[operation.parameter];
      if (!track?.length) {
        effect.parameters[operation.parameter] = operation.value;
        break;
      }
      effect.parameterKeyframes ??= {};
      const inserted = insertKeyframe(
        { mode: "animated", keyframes: track },
        {
          id: operation.keyframeId,
          time: Math.max(0, operation.time),
          value: operation.value,
          interpolation: "bezier",
          easing: [0.42, 0, 0.58, 1],
        },
      );
      if (inserted.mode === "animated")
        effect.parameterKeyframes[operation.parameter] = inserted.keyframes;
      break;
    }
    case "addEffectParameterKeyframe": {
      const effect = layer.effects.find((entry) => entry.id === operation.effectId);
      if (!effect) throw new Error("Effect does not exist");
      effect.parameterKeyframes ??= {};
      const inserted = insertKeyframe(
        { mode: "animated", keyframes: effect.parameterKeyframes[operation.parameter] ?? [] },
        operation.keyframe,
      );
      if (inserted.mode === "animated")
        effect.parameterKeyframes[operation.parameter] = inserted.keyframes;
      break;
    }
    case "removeEffectParameterKeyframe": {
      const effect = layer.effects.find((entry) => entry.id === operation.effectId);
      if (!effect) throw new Error("Effect does not exist");
      const track = effect.parameterKeyframes?.[operation.parameter];
      if (!track) break;
      const removed = track.find((keyframe) => keyframe.id === operation.keyframeId);
      const remaining = track.filter((keyframe) => keyframe.id !== operation.keyframeId);
      if (remaining.length) {
        effect.parameterKeyframes ??= {};
        effect.parameterKeyframes[operation.parameter] = remaining;
      } else {
        effect.parameters[operation.parameter] =
          removed?.value ?? effect.parameters[operation.parameter];
        delete effect.parameterKeyframes?.[operation.parameter];
      }
      break;
    }
    case "moveEffectParameterKeyframe": {
      const effect = layer.effects.find((entry) => entry.id === operation.effectId);
      if (!effect) throw new Error("Effect does not exist");
      const tracks = effect.parameterKeyframes;
      const track = tracks?.[operation.parameter];
      const keyframe = track?.find((entry) => entry.id === operation.keyframeId);
      if (!tracks || !track || !keyframe) throw new Error("Effect keyframe does not exist");
      const nextTime = Math.max(0, operation.time);
      tracks[operation.parameter] = track
        .filter(
          (entry) =>
            entry.id === operation.keyframeId || Math.abs(entry.time - nextTime) > 0.000_001,
        )
        .map((entry) => (entry.id === operation.keyframeId ? { ...entry, time: nextTime } : entry))
        .sort((left, right) => left.time - right.time);
      break;
    }
  }
}

function assertAdjustmentOperationSupported(layer: Layer, operation: Operation): void {
  if (layer.kind !== "adjustment") return;
  if (operation.type === "setBlendMode" && operation.blendMode !== "normal")
    throw new Error("Adjustment layers use replace semantics and require normal blend mode");
  const mappingOperations: readonly Operation["type"][] = [
    "setParent",
    "setLayerTimeMapping",
    "setLayerTimeRemap",
    "setProperty",
    "addKeyframe",
    "moveKeyframe",
    "updateKeyframe",
    "removeKeyframe",
    "easeLayer",
    "setExpression",
  ];
  if (mappingOperations.includes(operation.type))
    throw new Error(`Operation ${operation.type} has no visual meaning for adjustment layers`);
  if (
    operation.type === "toggleLayer" &&
    (operation.field === "threeDimensional" || operation.field === "audioEnabled")
  )
    throw new Error(`Adjustment layers cannot toggle ${operation.field}`);
  const sourceOperations: readonly Operation["type"][] = [
    "setLayerAudioGain",
    "setLayerAudioSettings",
    "setMaterial3d",
    "setLightSettings",
    "setLayerColor",
    "setSolidSettings",
    "setLayerSource",
    "setCameraSettings",
    "setSceneGenerator",
    "setClonerSettings",
    "setShapeSettings",
    "setShapeGraph",
    "setTextContent",
    "setTextStyle",
    "setTextAnimator",
  ];
  if (sourceOperations.includes(operation.type))
    throw new Error(`Operation ${operation.type} is not supported for adjustment layers`);
}

export function cloneProjectSnapshot(project: Project): Project {
  return {
    ...project,
    compositions: project.compositions.map((composition) => structuredClone(composition)),
    sources: [...project.sources],
    folders: project.folders.map((folder) => ({ ...folder })),
    itemFolderIds: { ...project.itemFolderIds },
    commandLog: project.commandLog.map((entry) => ({ ...entry })),
  };
}

function copySourceForOperation(source: FootageSource): FootageSource {
  return {
    ...source,
    interpretation: { ...source.interpretation },
    ...(source.kind === "video" && source.audio ? { audio: { ...source.audio } } : {}),
  } as FootageSource;
}

function normalizeSourceInterpretation(interpretation: SourceInterpretation): SourceInterpretation {
  if (!["straight", "premultiplied", "ignore"].includes(interpretation.alpha))
    throw new Error("Footage alpha interpretation is invalid");
  if (!["srgb", "linear", "display-p3"].includes(interpretation.colorSpace))
    throw new Error("Footage color-space interpretation is invalid");
  return {
    alpha: interpretation.alpha,
    colorSpace: interpretation.colorSpace,
    ...(interpretation.frameRate
      ? {
          frameRate: {
            numerator: Math.round(
              clamp(interpolationRate(interpretation.frameRate.numerator), 1, 240_000),
            ),
            denominator: Math.round(
              clamp(interpolationRate(interpretation.frameRate.denominator), 1, 240_000),
            ),
          },
        }
      : {}),
  };
}

function interpolationRate(value: number): number {
  return Number.isFinite(value) ? value : 1;
}

function assertOperationalSource(source: FootageSource): void {
  if (!source.id || source.id.length > 256 || !source.name.trim() || source.name.length > 512)
    throw new Error("Footage source identity is invalid");
  if (
    !["still", "video", "audio", "imageSequence", "svg", "psd"].includes(source.kind) ||
    !source.mimeType ||
    source.mimeType.length > 256
  )
    throw new Error("Footage source type is invalid");
  assertSourceLocator(
    source.contentIdentity,
    source.dataUrl,
    source.relativePath,
    source.runtimeUrl,
  );
  if (
    "width" in source &&
    (!Number.isSafeInteger(source.width) || source.width < 1 || source.width > 30_000)
  )
    throw new Error("Footage source width is invalid");
  if (
    "height" in source &&
    (!Number.isSafeInteger(source.height) || source.height < 1 || source.height > 30_000)
  )
    throw new Error("Footage source height is invalid");
  if (
    "duration" in source &&
    (!Number.isFinite(source.duration) || source.duration <= 0 || source.duration > 86_400)
  )
    throw new Error("Footage source duration is invalid");
  if (
    source.kind === "audio" &&
    (!Number.isSafeInteger(source.channels) || source.channels < 1 || source.channels > 32)
  )
    throw new Error("Footage source channel count is invalid");
  if (
    source.kind === "audio" &&
    (!Number.isSafeInteger(source.sampleRate) ||
      source.sampleRate < 8_000 ||
      source.sampleRate > 384_000)
  )
    throw new Error("Footage source sample rate is invalid");
  if (
    source.kind === "audio" &&
    (!Number.isSafeInteger(source.streamIndex) ||
      source.streamIndex < 0 ||
      source.streamIndex >= 128)
  )
    throw new Error("Footage source stream index is invalid");
  if (source.kind === "video" && source.audio) {
    if (
      !Number.isSafeInteger(source.audio.streamIndex) ||
      source.audio.streamIndex < 0 ||
      source.audio.streamIndex >= 128 ||
      !Number.isSafeInteger(source.audio.channels) ||
      source.audio.channels < 1 ||
      source.audio.channels > 32 ||
      !Number.isSafeInteger(source.audio.sampleRate) ||
      source.audio.sampleRate < 8_000 ||
      source.audio.sampleRate > 384_000
    )
      throw new Error("Video source audio metadata is invalid");
  }
  if (
    source.kind === "imageSequence" &&
    (!source.pattern ||
      source.pattern.length > 1024 ||
      !Number.isSafeInteger(source.startFrame) ||
      !Number.isSafeInteger(source.endFrame) ||
      source.endFrame < source.startFrame)
  )
    throw new Error("Footage source sequence range is invalid");
  if (
    source.kind === "psd" &&
    (!Number.isSafeInteger(source.layerCount) ||
      source.layerCount < 1 ||
      source.layerCount > 10_000)
  )
    throw new Error("Footage source PSD layer count is invalid");
  normalizeSourceInterpretation(source.interpretation);
}

function assertSourceLocator(
  contentIdentity: string,
  dataUrl?: string,
  relativePath?: string,
  runtimeUrl?: string,
): void {
  if (!contentIdentity || contentIdentity.length > 256)
    throw new Error("Footage content identity is invalid");
  if (dataUrl && (!dataUrl.startsWith("data:") || dataUrl.length > 136 * 1024 * 1024))
    throw new Error("Footage embedded data is invalid");
  if (
    relativePath &&
    (relativePath.length > 1024 ||
      relativePath.includes("\\") ||
      relativePath.startsWith("/") ||
      relativePath.split("/").some((segment) => segment === ".."))
  )
    throw new Error("Footage relative path is invalid");
  if (runtimeUrl && runtimeUrl.length > 4096) throw new Error("Footage runtime URL is invalid");
}

function clamp01(value: number): number {
  return clamp(value, 0, 1);
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Number.isFinite(value) ? Math.max(minimum, Math.min(maximum, value)) : minimum;
}

function validateParent(layers: Layer[], layerId: Id, parentId: Id | undefined): void {
  if (!parentId) return;
  if (parentId === layerId) throw new Error("A layer cannot parent itself");
  let current = layers.find((entry) => entry.id === parentId);
  if (!current) throw new Error("Parent layer does not exist");
  const visited = new Set<Id>();
  while (current?.parentId) {
    if (current.parentId === layerId) throw new Error("Parenting would create a cycle");
    if (visited.has(current.parentId)) throw new Error("Existing layer hierarchy contains a cycle");
    visited.add(current.parentId);
    current = layers.find((entry) => entry.id === current?.parentId);
  }
}

function easeTransform(layer: Layer): void {
  const properties = [
    ...layer.transform.position,
    ...layer.transform.rotation,
    ...layer.transform.scale,
    ...layer.transform.anchor,
    layer.transform.opacity,
    ...(layer.camera ? [...layer.camera.pointOfInterest, ...layer.camera.orientation] : []),
  ];
  for (const property of properties) {
    if (property.mode !== "animated") continue;
    for (const keyframe of property.keyframes) {
      keyframe.interpolation = "bezier";
      keyframe.easing = [0.42, 0, 0.58, 1];
    }
  }
}

export function getProperty(layer: Layer, path: PropertyPath): Animatable {
  if (path === "opacity") return layer.transform.opacity;
  if (path.startsWith("camera.")) {
    if (!layer.camera) throw new Error("Camera property requires a camera layer");
    const [, group, component] = path.split(".") as [
      "camera",
      "pointOfInterest" | "orientation",
      "0" | "1" | "2",
    ];
    return layer.camera[group][Number(component)];
  }
  const [group, component] = path.split(".") as [
    "position" | "rotation" | "scale",
    "0" | "1" | "2",
  ];
  return layer.transform[group][Number(component)];
}

function setProperty(layer: Layer, path: PropertyPath, value: Animatable): void {
  if (path === "opacity") {
    layer.transform.opacity = value;
    return;
  }
  if (path.startsWith("camera.")) {
    if (!layer.camera) throw new Error("Camera property requires a camera layer");
    const [, group, component] = path.split(".") as [
      "camera",
      "pointOfInterest" | "orientation",
      "0" | "1" | "2",
    ];
    layer.camera[group][Number(component)] = value;
    return;
  }
  const [group, component] = path.split(".") as [
    "position" | "rotation" | "scale",
    "0" | "1" | "2",
  ];
  layer.transform[group][Number(component)] = value;
}
