import {
  createDefaultTextAnimator,
  normalizeTextAnimatorSettings,
} from "../core/animation/text-animator";
import { migrateLegacyTextAnimator } from "../core/animation/text-animator-migration";
import type { TextAnimatorGroup } from "../core/animation/text-animator-stack";
import { cloneTimelineLayers } from "../core/editing/clone-layers";
import { applyOperation, type Operation, type PropertyPath } from "../core/editing/operations";
import { createLayerForComposition } from "../core/layers/layer-factory";
import { applySolidSettings } from "../core/layers/solid-layer";
import { activeComposition } from "../core/project/project";
import { validateProjectDocument } from "../core/project/project-file";
import { createParticleLayerForComposition } from "../core/scene/bundled-particle";
import {
  createId,
  type Layer,
  type LayerKind,
  type Project,
  setLayerSizeAndCenterAnchor,
} from "../core/types";
import { createEffect, EFFECT_BY_TYPE } from "../effects/registry";
import { getCommandDescriptors, type JsonSchema } from "./command-registry";
import { EDIT_LIMITS, EditError, encodedBytes, limitExceeded } from "./edit-limits";
import { normalizeExtendedAiCommand } from "./extended-command-normalizer";
import { didYouMean } from "./suggestions";

export const MAX_AI_COMMAND_BATCH = EDIT_LIMITS.commandsPerBatch;

const PROPERTY_PATHS = new Set<PropertyPath>([
  "shape.morphProgress",
  "position.0",
  "position.1",
  "position.2",
  "rotation.0",
  "rotation.1",
  "rotation.2",
  "scale.0",
  "scale.1",
  "scale.2",
  "anchor.0",
  "anchor.1",
  "anchor.2",
  "camera.pointOfInterest.0",
  "camera.pointOfInterest.1",
  "camera.pointOfInterest.2",
  "camera.orientation.0",
  "camera.orientation.1",
  "camera.orientation.2",
  "opacity",
]);

const AI_LAYER_KINDS = new Set<LayerKind>([
  "shape",
  "solid",
  "null",
  "audio",
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
  /** Non-fatal findings, such as layers that sample outside their source media. */
  warnings?: string[];
}

const MAX_BATCH_WARNINGS = 64;

export function normalizeAiCommands(
  values: readonly unknown[],
  project: Project,
  currentTime: number,
): NormalizedCommandBatch {
  if (values.length === 0 || values.length > MAX_AI_COMMAND_BATCH)
    throw new Error(`Command batch must contain 1 through ${MAX_AI_COMMAND_BATCH} commands`);
  const batch = new AiCommandBatch(project, currentTime);
  for (const value of values) batch.append(value);
  return batch.finish();
}

/** Own one candidate copy; never mutate the source project or replay payloads. */
export class AiCommandBatch {
  readonly project: Project;
  readonly operations: Operation[] = [];
  readonly #warnings = new Map<string, string>();
  #bytes = 0;
  constructor(
    project: Project,
    readonly currentTime: number,
    readonly maxOperations: number = EDIT_LIMITS.operationsPerWorkspace,
  ) {
    this.project = structuredClone(project);
  }
  append(value: unknown): Operation {
    if (this.operations.length >= this.maxOperations)
      limitExceeded("operations", this.operations.length + 1, this.maxOperations);
    let operation: Operation;
    try {
      operation = normalizeCommand(value, this.project, this.currentTime, this.operations.length);
    } catch (error) {
      throw commandError(error, value, this.project, this.operations.length);
    }
    this.#bytes += encodedBytes(operation);
    if (this.#bytes > EDIT_LIMITS.workspaceBytes)
      limitExceeded("operationBytes", this.#bytes, EDIT_LIMITS.workspaceBytes);
    applyOperation(this.project, structuredClone(operation));
    this.operations.push(operation);
    this.#checkTimeMapping(operation);
    return operation;
  }
  get warnings(): string[] {
    return [...this.#warnings.values()];
  }
  warningFor(layerId: string): string | undefined {
    return this.#warnings.get(layerId);
  }
  finish(): NormalizedCommandBatch {
    const warnings = this.warnings;
    return {
      project: validateProjectDocument(this.project),
      operations: this.operations,
      changedObjectIds: changedIds(this.operations),
      ...(warnings.length ? { warnings } : {}),
    };
  }
  #checkTimeMapping(operation: Operation) {
    if (
      operation.type !== "setLayerTimeMapping" &&
      operation.type !== "setLayerTiming" &&
      operation.type !== "setLayerSource" &&
      operation.type !== "setLayerTimeRemap"
    )
      return;
    const composition = activeComposition(this.project);
    const layer = composition.layers.find((candidate) => candidate.id === operation.layerId);
    const warning = layer ? timeMappingWarning(this.project, layer) : undefined;
    if (!warning) this.#warnings.delete(operation.layerId);
    else if (this.#warnings.has(operation.layerId) || this.#warnings.size < MAX_BATCH_WARNINGS)
      this.#warnings.set(operation.layerId, warning);
  }
}

/** Source-time span sampled by a layer: sourceTime = offset + (t - inPoint) / stretch. */
export function layerSourceRange(project: Project, layer: Layer) {
  const duration = layerSourceDuration(project, layer);
  if (duration === undefined || layer.timeRemap) return null;
  const stretch = Math.max(0.01, layer.timeStretch ?? 1);
  const start = layer.timeOffset ?? 0;
  return {
    start,
    end: start + Math.max(0, layer.outPoint - layer.inPoint) / stretch,
    sourceDuration: duration,
  };
}

function layerSourceDuration(project: Project, layer: Layer): number | undefined {
  if (layer.sourceCompositionId)
    return project.compositions.find((c) => c.id === layer.sourceCompositionId)?.duration;
  if (!layer.sourceId) return undefined;
  const source = project.sources.find((candidate) => candidate.id === layer.sourceId);
  return source && (source.kind === "video" || source.kind === "audio")
    ? source.duration
    : undefined;
}

export function timeMappingWarning(project: Project, layer: Layer): string | undefined {
  const range = layerSourceRange(project, layer);
  if (!range || !(range.sourceDuration > 0)) return undefined;
  const span = `${seconds(range.start)}-${seconds(range.end)}s`;
  const source = `source (0-${seconds(range.sourceDuration)}s)`;
  if (range.start >= range.sourceDuration)
    return `Layer "${layer.name}" (${layer.id}) maps entirely outside its ${source}: it samples ${span}, so it shows only a held last frame or nothing. offset is the source time shown at inPoint (sourceTime = offset + (t - inPoint) / stretch), not a shift relative to the composition.`;
  if (range.end > range.sourceDuration + 0.05)
    return `Layer "${layer.name}" (${layer.id}) runs past the end of its ${source} by ${seconds(range.end - range.sourceDuration)}s; the tail holds the last frame.`;
  return undefined;
}

function seconds(value: number): string {
  return String(Math.round(value * 1000) / 1000);
}

function commandError(error: unknown, value: unknown, project: Project, index: number): unknown {
  if (error instanceof EditError || !(error instanceof Error)) return error;
  const type = isRecord(value) && typeof value.type === "string" ? value.type : "unknown";
  const composition = activeComposition(project);
  let message = error.message.startsWith("Command ")
    ? error.message
    : `Command ${index + 1} (${type}): ${error.message}`;
  if (/^Layer does not exist/u.test(error.message))
    message += ` (not found in the active composition "${composition.name}" ${composition.id}; layer IDs belong to one composition, so switch with setActiveComposition or use that composition's script handle)`;
  return new EditError("invalid_command", message, {
    commandIndex: index,
    commandType: type,
    activeCompositionId: composition.id,
  });
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
      if (input.size !== undefined) {
        if (created.kind !== "text" && created.kind !== "shape")
          throw new Error("Explicit layer size is supported for text and shape layers only");
        setLayerSizeAndCenterAnchor(created, input.size as [number, number]);
      }
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
        setLayerSizeAndCenterAnchor(created, [source.width, source.height]);
      }
      return { type: "addLayer", layer: created };
    }
    case "duplicateLayer": {
      const original = requireLayer(layer, layerId);
      const duplicate = cloneTimelineLayers([original], false)[0];
      duplicate.name = typeof input.name === "string" ? input.name.trim() : `${original.name} Copy`;
      return { type: "addLayer", layer: duplicate };
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
        field: input.field as
          | "visible"
          | "solo"
          | "locked"
          | "audioEnabled"
          | "threeDimensional"
          | "motionBlur",
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
          interpolation:
            (input.interpolation as "linear" | "step" | "bezier" | undefined) ?? "bezier",
          ...((input.interpolation ?? "bezier") === "bezier"
            ? {
                easing: (input.easing as [number, number, number, number] | undefined) ?? [
                  0.16, 1, 0.3, 1,
                ],
              }
            : {}),
        },
      };
    case "addEffect": {
      requireLayer(layer, layerId);
      const effectType = String(input.effectType);
      if (!EFFECT_BY_TYPE.has(effectType))
        throw new Error(
          `Effect type does not exist: ${effectType}.${didYouMean(effectType, EFFECT_BY_TYPE.keys(), 5) || " Use describe {topic:'effects'} to browse effect types."}`,
        );
      const effect = createEffect(effectType);
      if (typeof input.name === "string") effect.name = input.name.trim().slice(0, 256);
      if (isRecord(input.parameters)) {
        for (const [parameter, parameterValue] of Object.entries(input.parameters)) {
          if (!(parameter in effect.parameters))
            throw new Error(
              `Effect parameter does not exist on ${effectType}: ${parameter}. Parameters: ${Object.keys(effect.parameters).join(", ")}`,
            );
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
        throw new Error(
          `Effect parameter does not exist on ${effect.type}: ${parameter}. Parameters: ${Object.keys(effect.parameters).join(", ")}`,
        );
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
      if (Array.isArray(input.groups))
        return {
          type: "setTextAnimator",
          layerId,
          textAnimator: normalizeTextAnimatorSettings({
            enabled: typeof input.enabled === "boolean" ? input.enabled : true,
            groups: input.groups.map(textAnimatorGroupInput),
          }),
        };
      const hasLegacyReveal = [
        input.delay,
        input.stagger,
        input.duration,
        input.position,
        input.scale,
        input.opacity,
      ].some((value) => value !== undefined);
      const base = hasLegacyReveal
        ? migrateLegacyTextAnimator(
            {
              enabled: typeof input.enabled === "boolean" ? input.enabled : true,
              delay: typeof input.delay === "number" ? input.delay : 0,
              stagger: typeof input.stagger === "number" ? input.stagger : 0.04,
              duration: typeof input.duration === "number" ? input.duration : 0.5,
              position: Array.isArray(input.position)
                ? [Number(input.position[0]), Number(input.position[1])]
                : [0, 64],
              scale: typeof input.scale === "number" ? input.scale : 80,
              opacity: typeof input.opacity === "number" ? input.opacity : 0,
            },
            `${existing.id}:ai`,
          )
        : (existing.textAnimator ?? createDefaultTextAnimator(true));
      return {
        type: "setTextAnimator",
        layerId,
        textAnimator: normalizeTextAnimatorSettings({
          ...base,
          enabled: typeof input.enabled === "boolean" ? input.enabled : base.enabled,
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
        if (!(key in properties))
          return `${path}.${key} is not allowed (allowed: ${Object.keys(properties).join(", ")})`;
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
    if (operation.type === "addProjectFont") ids.add(operation.font.id);
    if (operation.type === "removeProjectFont") ids.add(operation.fontId);
    if ("sourceId" in operation && operation.sourceId) ids.add(operation.sourceId);
    if (operation.type === "addSource") ids.add(operation.source.id);
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
    throw new Error(
      `Property path is not supported: ${String(value)}. Supported paths: ${[...PROPERTY_PATHS].join(", ")}`,
    );
}

/** Fills agent-friendly defaults before the shared stack normalizer bounds every field. */
function textAnimatorGroupInput(value: unknown, index: number): TextAnimatorGroup {
  const group = isRecord(value) ? value : {};
  const selectors = Array.isArray(group.selectors) ? group.selectors : [{}];
  return {
    ...group,
    id: typeof group.id === "string" ? group.id : createId(),
    name: typeof group.name === "string" ? group.name : `Animator ${index + 1}`,
    enabled: group.enabled !== false,
    randomSeed: typeof group.randomSeed === "number" ? group.randomSeed : 0,
    selectors: selectors.map((selector) => {
      const input = isRecord(selector) ? selector : {};
      return {
        ...input,
        id: typeof input.id === "string" ? input.id : createId(),
        kind: input.kind === "expression" || input.kind === "wiggly" ? input.kind : "range",
        enabled: input.enabled !== false,
      };
    }),
    properties: isRecord(group.properties) ? group.properties : {},
  } as unknown as TextAnimatorGroup;
}

function finiteTime(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
