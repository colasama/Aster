import { createParticleLayerForComposition } from "../core/bundled-particle";
import { createLayerForComposition } from "../core/layer-factory";
import { applyOperations, type Operation, type PropertyPath } from "../core/operations";
import { activeComposition } from "../core/project";
import { validateProjectDocument } from "../core/project-file";
import { applySolidSettings } from "../core/solid-layer";
import { createDefaultTextAnimator, normalizeTextAnimatorSettings } from "../core/text-animator";
import { createId, type LayerKind, type Project } from "../core/types";
import { createEffect, EFFECT_BY_TYPE } from "../effects/registry";
import { getCommandDescriptors, type JsonSchema } from "./command-registry";
import { normalizeExtendedAiCommand } from "./extended-command-normalizer";

export const MAX_AI_COMMAND_BATCH = 12;

const PROPERTY_PATHS = new Set<PropertyPath>([
  "position.0",
  "position.1",
  "position.2",
  "rotation.0",
  "rotation.1",
  "rotation.2",
  "scale.0",
  "scale.1",
  "scale.2",
  "opacity",
]);

const AI_LAYER_KINDS = new Set<LayerKind>([
  "shape",
  "solid",
  "null",
  "text",
  "image",
  "video",
  "mesh",
  "generator",
  "precomposition",
  "adjustment",
  "camera",
  "light",
]);

export interface NormalizedCommandBatch {
  operations: Operation[];
  project: Project;
  changedObjectIds: string[];
}

export function normalizeAiCommands(
  values: readonly unknown[],
  project: Project,
  currentTime: number,
): NormalizedCommandBatch {
  if (values.length === 0 || values.length > MAX_AI_COMMAND_BATCH)
    throw new Error(`Command batch must contain 1 through ${MAX_AI_COMMAND_BATCH} commands`);
  const operations: Operation[] = [];
  let next = structuredClone(project);
  for (const [index, value] of values.entries()) {
    const operation = normalizeCommand(value, next, currentTime, index);
    next = validateProjectDocument(applyOperations(next, [operation]));
    operations.push(operation);
  }
  return {
    operations,
    project: next,
    changedObjectIds: changedIds(operations),
  };
}

function normalizeCommand(
  value: unknown,
  project: Project,
  currentTime: number,
  index: number,
): Operation {
  if (!isRecord(value) || typeof value.type !== "string")
    throw new Error(`Command ${index + 1} must be an object with a type`);
  const descriptor = getCommandDescriptors([value.type])[0];
  const validationError = validateJsonSchema(value, descriptor.inputSchema, "$command");
  if (validationError) throw new Error(`Command ${index + 1} is invalid: ${validationError}`);

  const input = value as Record<string, unknown> & { type: string };
  const composition = activeComposition(project);
  const layerId = typeof input.layerId === "string" ? input.layerId : "";
  const layer = composition.layers.find((candidate) => candidate.id === layerId);

  switch (input.type) {
    case "addLayer": {
      const kind = input.kind as LayerKind;
      if (!AI_LAYER_KINDS.has(kind)) throw new Error("Layer kind is unavailable to the AI");
      const created =
        kind === "generator"
          ? createParticleLayerForComposition(composition, finiteTime(currentTime))
          : createLayerForComposition(kind, composition, finiteTime(currentTime));
      if (typeof input.name === "string") created.name = input.name.trim().slice(0, 256);
      if (typeof input.text === "string" && created.kind === "text") created.text = input.text;
      if (created.kind === "solid" && input.solid)
        applySolidSettings(
          created,
          structuredClone(input.solid as NonNullable<typeof created.solid>),
        );
      if (created.kind === "precomposition") {
        const sourceCompositionId = String(input.sourceCompositionId ?? "");
        const source = project.compositions.find(
          (candidate) => candidate.id === sourceCompositionId && candidate.id !== composition.id,
        );
        if (!source) throw new Error("Precomposition layers require another source composition");
        created.sourceCompositionId = source.id;
        created.name = typeof input.name === "string" ? created.name : source.name;
        created.size = [source.width, source.height];
      }
      return { type: "addLayer", layer: created };
    }
    case "removeLayer":
      requireLayer(layer, layerId);
      return { type: "removeLayer", layerId };
    case "renameLayer":
      requireLayer(layer, layerId);
      return { type: "renameLayer", layerId, name: String(input.name).trim().slice(0, 256) };
    case "reorderLayer":
      requireLayer(layer, layerId);
      return { type: "reorderLayer", layerId, index: Number(input.index) };
    case "toggleLayer":
      requireLayer(layer, layerId);
      return {
        type: "toggleLayer",
        layerId,
        field: input.field as "visible" | "solo" | "locked" | "audioEnabled" | "threeDimensional",
      };
    case "setProperty":
      requireLayer(layer, layerId);
      requirePropertyPath(input.path);
      return { type: "setProperty", layerId, path: input.path, value: Number(input.value) };
    case "addKeyframe":
      requireLayer(layer, layerId);
      requirePropertyPath(input.path);
      return {
        type: "addKeyframe",
        layerId,
        path: input.path,
        keyframe: {
          id: createId(),
          time: Number(input.time),
          value: Number(input.value),
          interpolation: "bezier",
          easing: [0.16, 1, 0.3, 1],
        },
      };
    case "addEffect": {
      requireLayer(layer, layerId);
      const effectType = String(input.effectType);
      if (!EFFECT_BY_TYPE.has(effectType))
        throw new Error(`Effect type does not exist: ${effectType}`);
      const effect = createEffect(effectType);
      if (typeof input.name === "string") effect.name = input.name.trim().slice(0, 256);
      if (isRecord(input.parameters)) {
        for (const [parameter, parameterValue] of Object.entries(input.parameters)) {
          if (!(parameter in effect.parameters))
            throw new Error(`Effect parameter does not exist: ${parameter}`);
          effect.parameters[parameter] = Number(parameterValue);
        }
      }
      return { type: "addEffect", layerId, effect };
    }
    case "removeEffect": {
      const existing = requireLayer(layer, layerId);
      const effectId = String(input.effectId);
      requireEffect(existing.effects, effectId);
      return { type: "removeEffect", layerId, effectId };
    }
    case "setEffectParameter": {
      const existing = requireLayer(layer, layerId);
      const effectId = String(input.effectId);
      const effect = requireEffect(existing.effects, effectId);
      const parameter = String(input.parameter);
      if (!(parameter in effect.parameters))
        throw new Error(`Effect parameter does not exist: ${parameter}`);
      return {
        type: "setEffectParameter",
        layerId,
        effectId,
        parameter,
        value: Number(input.value),
      };
    }
    case "setTextAnimator": {
      const existing = requireLayer(layer, layerId);
      if (existing.kind !== "text") throw new Error("Text animation requires a text layer");
      const current = existing.textAnimator ?? createDefaultTextAnimator(true);
      return {
        type: "setTextAnimator",
        layerId,
        textAnimator: normalizeTextAnimatorSettings({
          ...current,
          enabled: typeof input.enabled === "boolean" ? input.enabled : true,
          delay: typeof input.delay === "number" ? input.delay : current.delay,
          stagger: typeof input.stagger === "number" ? input.stagger : current.stagger,
          duration: typeof input.duration === "number" ? input.duration : current.duration,
          position: Array.isArray(input.position)
            ? [Number(input.position[0]), Number(input.position[1])]
            : current.position,
          scale: typeof input.scale === "number" ? input.scale : current.scale,
          opacity: typeof input.opacity === "number" ? input.opacity : current.opacity,
        }),
      };
    }
    default:
      return (
        normalizeExtendedAiCommand(input, project) ??
        (() => {
          throw new Error(`Command is not implemented: ${input.type}`);
        })()
      );
  }
}

export function validateJsonSchema(
  value: unknown,
  schema: JsonSchema,
  path = "$",
): string | undefined {
  if (Array.isArray(schema.oneOf)) {
    const matches = schema.oneOf.filter(
      (candidate) => isRecord(candidate) && !validateJsonSchema(value, candidate, path),
    ).length;
    if (matches !== 1) return `${path} must match exactly one supported shape`;
    return undefined;
  }
  if ("const" in schema && value !== schema.const)
    return `${path} must equal ${String(schema.const)}`;
  if (Array.isArray(schema.enum) && !schema.enum.includes(value))
    return `${path} has an unsupported value`;
  if (schema.type === "object") {
    if (!isRecord(value)) return `${path} must be an object`;
    const properties = isRecord(schema.properties) ? schema.properties : {};
    const required = Array.isArray(schema.required) ? schema.required : [];
    for (const key of required)
      if (typeof key === "string" && !(key in value)) return `${path}.${key} is required`;
    if (schema.additionalProperties === false)
      for (const key of Object.keys(value))
        if (!(key in properties)) return `${path}.${key} is not allowed`;
    if (
      typeof schema.maxProperties === "number" &&
      Object.keys(value).length > schema.maxProperties
    )
      return `${path} has too many properties`;
    for (const [key, child] of Object.entries(value)) {
      const propertySchema = properties[key];
      const fallbackSchema = isRecord(schema.additionalProperties)
        ? schema.additionalProperties
        : undefined;
      const childSchema = isRecord(propertySchema) ? propertySchema : fallbackSchema;
      if (!childSchema) continue;
      const error = validateJsonSchema(child, childSchema, `${path}.${key}`);
      if (error) return error;
    }
    return undefined;
  }
  if (schema.type === "array") {
    if (!Array.isArray(value)) return `${path} must be an array`;
    if (typeof schema.minItems === "number" && value.length < schema.minItems)
      return `${path} has too few items`;
    if (typeof schema.maxItems === "number" && value.length > schema.maxItems)
      return `${path} has too many items`;
    if (isRecord(schema.items))
      for (const [index, child] of value.entries()) {
        const error = validateJsonSchema(child, schema.items, `${path}[${index}]`);
        if (error) return error;
      }
    return undefined;
  }
  if (schema.type === "string") {
    if (typeof value !== "string") return `${path} must be a string`;
    if (typeof schema.minLength === "number" && value.length < schema.minLength)
      return `${path} is too short`;
    if (typeof schema.maxLength === "number" && value.length > schema.maxLength)
      return `${path} is too long`;
    return undefined;
  }
  if (schema.type === "number" || schema.type === "integer") {
    if (typeof value !== "number" || !Number.isFinite(value)) return `${path} must be finite`;
    if (schema.type === "integer" && !Number.isInteger(value)) return `${path} must be an integer`;
    if (typeof schema.minimum === "number" && value < schema.minimum) return `${path} is too small`;
    if (typeof schema.maximum === "number" && value > schema.maximum) return `${path} is too large`;
    return undefined;
  }
  if (schema.type === "boolean" && typeof value !== "boolean") return `${path} must be boolean`;
  return undefined;
}

function changedIds(operations: readonly Operation[]): string[] {
  const ids = new Set<string>();
  for (const operation of operations) {
    if ("layerId" in operation) ids.add(operation.layerId);
    if (operation.type === "addLayer") ids.add(operation.layer.id);
    if ("compositionId" in operation) ids.add(operation.compositionId);
    if (operation.type === "addComposition") ids.add(operation.composition.id);
    if (operation.type === "addProjectFolder") ids.add(operation.folder.id);
    if (operation.type === "moveProjectItem") ids.add(operation.itemId);
    if (operation.type === "precomposeLayers") {
      ids.add(operation.wrapper.id);
      ids.add(operation.nestedComposition.id);
      for (const id of operation.selectedIds) ids.add(id);
    }
  }
  return [...ids];
}

function requireLayer<T>(layer: T | undefined, layerId: string): T {
  if (!layer) throw new Error(`Layer does not exist: ${layerId}`);
  return layer;
}

function requireEffect<T extends { id: string }>(effects: readonly T[], effectId: string): T {
  const effect = effects.find((candidate) => candidate.id === effectId);
  if (!effect) throw new Error(`Effect does not exist: ${effectId}`);
  return effect;
}

function requirePropertyPath(value: unknown): asserts value is PropertyPath {
  if (typeof value !== "string" || !PROPERTY_PATHS.has(value as PropertyPath))
    throw new Error(`Property path is not supported: ${String(value)}`);
}

function finiteTime(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
