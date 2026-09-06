import { normalizeCameraSettings } from "../core/camera-settings";
import type { ClonerSettings } from "../core/cloner";
import type { Operation, PropertyPath } from "../core/operations";
import { planPrecomposition } from "../core/precomposition";
import { activeComposition, createBlankComposition } from "../core/project";
import type { ProjectFont } from "../core/project-fonts";
import type { ShapeGraph } from "../core/shape-graph";
import { resolveTextStyle } from "../core/text-style";
import {
  type Animatable,
  type AudioLayerSettings,
  type CameraSettings,
  createId,
  type EffectMask,
  type FootageSource,
  type Keyframe,
  type Layer,
  type LightSettings,
  type Lut3dResource,
  type Material3d,
  type Project,
  type SceneGeneratorInstance,
  type ShapeSettings,
  type SolidSettings,
  type SourceInterpretation,
  type TextStyle,
} from "../core/types";

export function normalizeExtendedAiCommand(
  input: Record<string, unknown> & { type: string },
  project: Project,
): Operation | undefined {
  const composition = activeComposition(project);
  const layerId = optionalId(input.layerId) ?? "";
  const layer = layerId
    ? composition.layers.find((candidate) => candidate.id === layerId)
    : undefined;
  switch (input.type) {
    case "addProjectFont":
      return { type: "addProjectFont", font: structuredClone(input.font as ProjectFont) };
    case "removeProjectFont":
      return { type: "removeProjectFont", fontId: requiredId(input.fontId, "fontId") };
    case "addSource":
      return { type: "addSource", source: copyFootageSourceInput(input.source) };
    case "removeSource":
      return { type: "removeSource", sourceId: requiredId(input.sourceId, "sourceId") };
    case "cleanupOrphanSources":
      return { type: "cleanupOrphanSources" };
    case "relinkSource":
      return {
        type: "relinkSource",
        sourceId: requiredId(input.sourceId, "sourceId"),
        name: String(input.name),
        contentIdentity: String(input.contentIdentity),
        ...(typeof input.dataUrl === "string" ? { dataUrl: input.dataUrl } : {}),
        ...(typeof input.relativePath === "string" ? { relativePath: input.relativePath } : {}),
        ...(typeof input.runtimeUrl === "string" ? { runtimeUrl: input.runtimeUrl } : {}),
      };
    case "reloadSource":
      return {
        type: "reloadSource",
        sourceId: requiredId(input.sourceId, "sourceId"),
        source: copyFootageSourceInput(input.source),
      };
    case "interpretSource":
      return {
        type: "interpretSource",
        sourceId: requiredId(input.sourceId, "sourceId"),
        interpretation: structuredClone(input.interpretation as SourceInterpretation),
      };
    case "setActiveComposition": {
      const compositionId = requiredId(input.compositionId, "compositionId");
      requireComposition(project, compositionId);
      return { type: "setActiveComposition", compositionId };
    }
    case "addComposition": {
      const created = createBlankComposition(String(input.name));
      created.width = Number(input.width);
      created.height = Number(input.height);
      created.frameRate = {
        numerator: Number(input.frameRateNumerator),
        denominator: Number(input.frameRateDenominator),
      };
      created.duration = Number(input.duration);
      created.workArea = { start: 0, end: created.duration };
      return { type: "addComposition", composition: created, activate: input.activate === true };
    }
    case "addProjectFolder": {
      const parentId = optionalId(input.parentId);
      if (parentId) requireFolder(project, parentId);
      return {
        type: "addProjectFolder",
        folder: { id: createId(), name: String(input.name), ...(parentId ? { parentId } : {}) },
      };
    }
    case "renameProjectItem":
      return {
        type: "renameProjectItem",
        itemId: requiredId(input.itemId, "itemId"),
        name: String(input.name),
      };
    case "moveProjectItem": {
      const itemId = requiredId(input.itemId, "itemId");
      const folderId = optionalId(input.folderId);
      if (folderId) requireFolder(project, folderId);
      return { type: "moveProjectItem", itemId, ...(folderId ? { folderId } : {}) };
    }
    case "moveProjectFolder": {
      const folderId = requiredId(input.folderId, "folderId");
      requireFolder(project, folderId);
      const parentId = optionalId(input.parentId);
      if (parentId) requireFolder(project, parentId);
      return { type: "moveProjectFolder", folderId, ...(parentId ? { parentId } : {}) };
    }
    case "removeProjectFolder": {
      const folderId = requiredId(input.folderId, "folderId");
      requireFolder(project, folderId);
      return { type: "removeProjectFolder", folderId };
    }
    case "removeComposition": {
      const compositionId = requiredId(input.compositionId, "compositionId");
      requireComposition(project, compositionId);
      return { type: "removeComposition", compositionId };
    }
    case "setCompositionSettings":
      requireComposition(project, requiredId(input.compositionId, "compositionId"));
      return {
        type: "setCompositionSettings",
        compositionId: String(input.compositionId),
        name: String(input.name),
        width: Number(input.width),
        height: Number(input.height),
        frameRate: {
          numerator: Number(input.frameRateNumerator),
          denominator: Number(input.frameRateDenominator),
        },
        duration: Number(input.duration),
      };
    case "setCompositionMotionBlur": {
      const compositionId = requiredId(input.compositionId, "compositionId");
      requireComposition(project, compositionId);
      return {
        type: "setCompositionMotionBlur",
        compositionId,
        motionBlur: {
          enabled: input.enabled === true,
          shutterAngle: Number(input.shutterAngle),
          shutterPhase: Number(input.shutterPhase),
          samplesPerFrame: Number(input.samplesPerFrame),
          adaptiveSampleLimit: Number(input.adaptiveSampleLimit),
        },
      };
    }
    case "setCompositionEnvironment": {
      const compositionId = requiredId(input.compositionId, "compositionId");
      const target = requireComposition(project, compositionId);
      if (input.clear === true) return { type: "setCompositionEnvironment", compositionId };
      if (!target.environment)
        throw new Error("Import an HDR environment before changing its settings");
      return {
        type: "setCompositionEnvironment",
        compositionId,
        environment: {
          ...structuredClone(target.environment),
          enabled: typeof input.enabled === "boolean" ? input.enabled : target.environment.enabled,
          intensity:
            typeof input.intensity === "number" ? input.intensity : target.environment.intensity,
          rotation:
            typeof input.rotation === "number" ? input.rotation : target.environment.rotation,
        },
      };
    }
    case "setCompositionWorkArea": {
      const compositionId = requiredId(input.compositionId, "compositionId");
      requireComposition(project, compositionId);
      return {
        type: "setCompositionWorkArea",
        compositionId,
        start: Number(input.start),
        end: Number(input.end),
      };
    }
    case "precomposeLayers": {
      const layerIds = (input.layerIds as string[]).filter(
        (id, index, values) => values.indexOf(id) === index,
      );
      const plan = planPrecomposition(project, layerIds);
      if (!plan) throw new Error("The selected layers cannot be precomposed");
      if (typeof input.name === "string") {
        plan.nestedComposition.name = input.name.trim().slice(0, 256);
        plan.wrapper.name = plan.nestedComposition.name;
      }
      return { type: "precomposeLayers", ...plan };
    }
    case "setBlendMode":
      requireLayer(layer, layerId);
      return { type: "setBlendMode", layerId, blendMode: input.blendMode as Layer["blendMode"] };
    case "setParent": {
      requireLayer(layer, layerId);
      const parentId = optionalId(input.parentId);
      if (parentId)
        requireLayer(
          composition.layers.find((entry) => entry.id === parentId),
          parentId,
        );
      return { type: "setParent", layerId, ...(parentId ? { parentId } : {}) };
    }
    case "setLayerTiming":
      requireLayer(layer, layerId);
      if (Number(input.outPoint) <= Number(input.inPoint))
        throw new Error("Layer out point must be later than its in point");
      return {
        type: "setLayerTiming",
        layerId,
        inPoint: Number(input.inPoint),
        outPoint: Number(input.outPoint),
      };
    case "setLayerTimeMapping":
      requireLayer(layer, layerId);
      return {
        type: "setLayerTimeMapping",
        layerId,
        offset: Number(input.offset),
        stretch: Number(input.stretch),
      };
    case "setLayerTimeRemap":
      requireLayer(layer, layerId);
      return {
        type: "setLayerTimeRemap",
        layerId,
        ...(input.value ? { value: structuredClone(input.value as Animatable) } : {}),
      };
    case "setLayerAudioGain":
      requireLayer(layer, layerId);
      return { type: "setLayerAudioGain", layerId, gain: Number(input.gain) };
    case "setLayerAudioSettings":
      requireAudioLayer(layer, layerId);
      return {
        type: "setLayerAudioSettings",
        layerId,
        audio: audioSettings(input.audio),
      };
    case "setMaterial3d":
      requireLayer(layer, layerId);
      return {
        type: "setMaterial3d",
        layerId,
        material: structuredClone(input.material as Material3d),
      };
    case "setLightSettings":
      requireLayerKind(layer, layerId, "light");
      return {
        type: "setLightSettings",
        layerId,
        light: structuredClone(input.light as LightSettings),
      };
    case "setLayerColor":
      requireLayer(layer, layerId);
      return { type: "setLayerColor", layerId, color: [...(input.color as Layer["color"])] };
    case "setSolidSettings":
      requireLayerKind(layer, layerId, "solid");
      return {
        type: "setSolidSettings",
        layerId,
        solid: structuredClone(input.solid as SolidSettings),
      };
    case "setLayerSource": {
      requireLayer(layer, layerId);
      const sourceId = optionalId(input.sourceId);
      if (sourceId && !project.sources.some((source) => source.id === sourceId))
        throw new Error("Footage source does not exist");
      return { type: "setLayerSource", layerId, ...(sourceId ? { sourceId } : {}) };
    }
    case "setCameraSettings":
      requireLayerKind(layer, layerId, "camera");
      return {
        type: "setCameraSettings",
        layerId,
        camera: normalizeCameraSettings(
          input.camera as Partial<CameraSettings>,
          composition.width,
          composition.height,
        ),
      };
    case "setSceneGenerator":
      requireLayerKind(layer, layerId, "generator");
      return {
        type: "setSceneGenerator",
        layerId,
        generator: structuredClone(input.generator as SceneGeneratorInstance),
      };
    case "setClonerSettings":
      requireLayer(layer, layerId);
      return {
        type: "setClonerSettings",
        layerId,
        ...(input.cloner ? { cloner: structuredClone(input.cloner as ClonerSettings) } : {}),
      };
    case "setShapeSettings":
      requireLayerKind(layer, layerId, "shape");
      return {
        type: "setShapeSettings",
        layerId,
        shape: structuredClone(input.shape as ShapeSettings),
      };
    case "setShapeGraph":
      requireLayerKind(layer, layerId, "shape");
      return {
        type: "setShapeGraph",
        layerId,
        ...(input.shapeGraph
          ? { shapeGraph: structuredClone(input.shapeGraph as ShapeGraph) }
          : {}),
      };
    case "setTextContent":
      requireLayerKind(layer, layerId, "text");
      return { type: "setTextContent", layerId, text: String(input.text) };
    case "setTextStyle":
      requireLayerKind(layer, layerId, "text");
      if (Object.keys(input.textStyle as object).length === 0)
        throw new Error("Text style update must contain at least one field");
      return {
        type: "setTextStyle",
        layerId,
        textStyle: {
          ...resolveTextStyle(requireLayer(layer, layerId)),
          ...structuredClone(input.textStyle as Partial<TextStyle>),
        },
      };
    case "moveKeyframe": {
      const existing = requireLayer(layer, layerId);
      const path = input.path as PropertyPath;
      requirePropertyKeyframe(existing, path, String(input.keyframeId));
      return {
        type: "moveKeyframe",
        layerId,
        path,
        keyframeId: String(input.keyframeId),
        time: Number(input.time),
      };
    }
    case "updateKeyframe": {
      const existing = requireLayer(layer, layerId);
      const path = input.path as PropertyPath;
      requirePropertyKeyframe(existing, path, String(input.keyframeId));
      return {
        type: "updateKeyframe",
        layerId,
        path,
        keyframeId: String(input.keyframeId),
        time: Number(input.time),
        value: Number(input.value),
        interpolation: input.interpolation as Keyframe["interpolation"],
        ...(input.easing ? { easing: easingValue(input.easing) } : {}),
        ...(typeof input.spatialIn === "number" ? { spatialIn: input.spatialIn } : {}),
        ...(typeof input.spatialOut === "number" ? { spatialOut: input.spatialOut } : {}),
      };
    }
    case "removeKeyframe": {
      const existing = requireLayer(layer, layerId);
      const path = input.path as PropertyPath;
      requirePropertyKeyframe(existing, path, String(input.keyframeId));
      return {
        type: "removeKeyframe",
        layerId,
        path,
        keyframeId: String(input.keyframeId),
      };
    }
    case "easeLayer":
      requireLayer(layer, layerId);
      return { type: "easeLayer", layerId };
    case "setExpression":
      requireLayer(layer, layerId);
      return {
        type: "setExpression",
        layerId,
        path: input.path as PropertyPath,
        expression: String(input.expression),
      };
    case "moveEffect":
      requireEffect(requireLayer(layer, layerId), String(input.effectId));
      return {
        type: "moveEffect",
        layerId,
        effectId: String(input.effectId),
        toIndex: Number(input.toIndex),
      };
    case "setEffectMask": {
      const existing = requireLayer(layer, layerId);
      requireEffect(existing, String(input.effectId));
      const mask = input.mask ? structuredClone(input.mask as EffectMask) : undefined;
      if (mask?.shape === "path") {
        if (!mask.pathId) throw new Error("Path effect masks require pathId");
        if (!existing.shapeGraph?.paths.some((path) => path.id === mask.pathId))
          throw new Error("Effect mask path does not exist on the owning layer");
      }
      return { type: "setEffectMask", layerId, effectId: String(input.effectId), mask };
    }
    case "toggleEffect":
      requireEffect(requireLayer(layer, layerId), String(input.effectId));
      return { type: "toggleEffect", layerId, effectId: String(input.effectId) };
    case "setEffectLut": {
      const effect = requireEffect(requireLayer(layer, layerId), String(input.effectId));
      if (effect.type !== "lut") throw new Error("LUT resources require a 3D LUT effect");
      return {
        type: "setEffectLut",
        layerId,
        effectId: effect.id,
        ...(input.resource ? { resource: structuredClone(input.resource as Lut3dResource) } : {}),
      };
    }
    case "setEffectParameterAtTime": {
      const effect = requireEffect(requireLayer(layer, layerId), String(input.effectId));
      const parameter = requireEffectParameter(effect, input.parameter);
      return {
        type: "setEffectParameterAtTime",
        layerId,
        effectId: effect.id,
        parameter,
        time: Number(input.time),
        value: Number(input.value),
        keyframeId: optionalId(input.keyframeId) ?? createId(),
      };
    }
    case "addEffectParameterKeyframe": {
      const effect = requireEffect(requireLayer(layer, layerId), String(input.effectId));
      const parameter = requireEffectParameter(effect, input.parameter);
      return {
        type: "addEffectParameterKeyframe",
        layerId,
        effectId: effect.id,
        parameter,
        keyframe: {
          id: createId(),
          time: Number(input.time),
          value: Number(input.value),
          interpolation: (input.interpolation as Keyframe["interpolation"] | undefined) ?? "bezier",
          ...(input.easing ? { easing: easingValue(input.easing) } : {}),
        },
      };
    }
    case "removeEffectParameterKeyframe": {
      const effect = requireEffect(requireLayer(layer, layerId), String(input.effectId));
      const parameter = requireEffectParameter(effect, input.parameter);
      requireEffectKeyframe(effect, parameter, String(input.keyframeId));
      return {
        type: "removeEffectParameterKeyframe",
        layerId,
        effectId: effect.id,
        parameter,
        keyframeId: String(input.keyframeId),
      };
    }
    case "moveEffectParameterKeyframe": {
      const effect = requireEffect(requireLayer(layer, layerId), String(input.effectId));
      const parameter = requireEffectParameter(effect, input.parameter);
      requireEffectKeyframe(effect, parameter, String(input.keyframeId));
      return {
        type: "moveEffectParameterKeyframe",
        layerId,
        effectId: effect.id,
        parameter,
        keyframeId: String(input.keyframeId),
        time: Number(input.time),
      };
    }
    default:
      return undefined;
  }
}

function copyFootageSourceInput(value: unknown): FootageSource {
  const source = value as FootageSource;
  return { ...source, interpretation: { ...source.interpretation } } as FootageSource;
}

function requireComposition(project: Project, id: string) {
  const composition = project.compositions.find((candidate) => candidate.id === id);
  if (!composition) throw new Error(`Composition does not exist: ${id}`);
  return composition;
}

function requireFolder(project: Project, id: string): void {
  if (!project.folders.some((folder) => folder.id === id))
    throw new Error(`Project folder does not exist: ${id}`);
}

function requireLayer<T extends Layer>(layer: T | undefined, id: string): T {
  if (!layer) throw new Error(`Layer does not exist: ${id}`);
  return layer;
}

function requireLayerKind(layer: Layer | undefined, id: string, kind: Layer["kind"]): Layer {
  const existing = requireLayer(layer, id);
  if (existing.kind !== kind) throw new Error(`Command requires a ${kind} layer`);
  return existing;
}

function requireAudioLayer(layer: Layer | undefined, id: string): Layer {
  const existing = requireLayer(layer, id);
  if (existing.kind !== "audio" && existing.kind !== "video")
    throw new Error("Command requires an audio-capable layer");
  return existing;
}

function audioSettings(value: unknown): AudioLayerSettings {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("audio must be an object");
  const input = value as Partial<AudioLayerSettings>;
  if (
    !Array.isArray(input.levelsDb) ||
    input.levelsDb.length !== 2 ||
    input.levelsDb.some((level) => !Number.isFinite(level)) ||
    !Number.isFinite(input.pan) ||
    typeof input.muted !== "boolean" ||
    typeof input.reversed !== "boolean"
  )
    throw new Error("audio settings must contain finite L/R levels, pan, mute, and reverse");
  return {
    levelsDb: [input.levelsDb[0], input.levelsDb[1]],
    pan: Number(input.pan),
    muted: input.muted,
    reversed: input.reversed,
  };
}

function requireEffect(layer: Layer, effectId: string) {
  const effect = layer.effects.find((candidate) => candidate.id === effectId);
  if (!effect) throw new Error(`Effect does not exist: ${effectId}`);
  return effect;
}

function requireEffectParameter(effect: Layer["effects"][number], value: unknown): string {
  const parameter = String(value);
  if (!(parameter in effect.parameters))
    throw new Error(`Effect parameter does not exist: ${parameter}`);
  return parameter;
}

function requireEffectKeyframe(
  effect: Layer["effects"][number],
  parameter: string,
  keyframeId: string,
): void {
  if (!effect.parameterKeyframes?.[parameter]?.some((keyframe) => keyframe.id === keyframeId))
    throw new Error(`Effect keyframe does not exist: ${keyframeId}`);
}

function requirePropertyKeyframe(layer: Layer, path: PropertyPath, keyframeId: string): void {
  const property = propertyValue(layer, path);
  if (property.mode !== "animated" || !property.keyframes.some((entry) => entry.id === keyframeId))
    throw new Error(`Keyframe does not exist: ${keyframeId}`);
}

function propertyValue(layer: Layer, path: PropertyPath): Animatable {
  if (path === "opacity") return layer.transform.opacity;
  const [group, axis] = path.split(".") as ["position" | "rotation" | "scale", string];
  return layer.transform[group][Number(axis)];
}

function requiredId(value: unknown, name: string): string {
  const id = optionalId(value);
  if (!id) throw new Error(`${name} must be a non-empty ID`);
  return id;
}

function optionalId(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function easingValue(value: unknown): [number, number, number, number] {
  const easing = value as [number, number, number, number];
  return [easing[0], easing[1], easing[2], easing[3]];
}
