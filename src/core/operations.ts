import { activeComposition } from "./project";
import { insertKeyframe } from "./timeline";
import type {
  Animatable,
  BlendMode,
  Effect,
  EffectMask,
  Id,
  Keyframe,
  Layer,
  Lut3dResource,
  Project,
} from "./types";

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
  | "opacity";

export type Operation =
  | { type: "addLayer"; layer: Layer }
  | { type: "removeLayer"; layerId: Id }
  | { type: "renameLayer"; layerId: Id; name: string }
  | { type: "reorderLayer"; layerId: Id; index: number }
  | { type: "setBlendMode"; layerId: Id; blendMode: BlendMode }
  | { type: "setParent"; layerId: Id; parentId?: Id }
  | { type: "setLayerTiming"; layerId: Id; inPoint: number; outPoint: number }
  | { type: "setLayerTimeMapping"; layerId: Id; offset: number; stretch: number }
  | { type: "setLayerTimeRemap"; layerId: Id; value?: Animatable }
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

export function applyOperations(project: Project, operations: Operation[]): Project {
  const next = structuredClone(project);
  for (const operation of operations) applyOperation(next, operation);
  next.updatedAt = new Date().toISOString();
  return next;
}

export function applyOperation(project: Project, operation: Operation): void {
  const composition = activeComposition(project);
  if (operation.type === "addLayer") {
    if (composition.layers.some((layer) => layer.id === operation.layer.id))
      throw new Error("Layer already exists");
    composition.layers.unshift(operation.layer);
    return;
  }
  const index = composition.layers.findIndex((layer) => layer.id === operation.layerId);
  if (index < 0) throw new Error("Layer does not exist");
  const layer = composition.layers[index];
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
    case "setBlendMode":
      layer.blendMode = operation.blendMode;
      break;
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
    case "toggleLayer":
      layer[operation.field] = !layer[operation.field];
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
      layer.effects.push(operation.effect);
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
  const [group, component] = path.split(".") as [
    "position" | "rotation" | "scale",
    "0" | "1" | "2",
  ];
  layer.transform[group][Number(component)] = value;
}
