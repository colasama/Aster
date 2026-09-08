import type { Effect, EffectMask, Keyframe } from "../../core/types";
import { createId } from "../../core/types";
import { createEffect, EFFECT_BY_TYPE } from "../registry";

export interface UserEffectPreset {
  id: string;
  name: string;
  createdAt: string;
  effects: UserEffectTemplate[];
}

interface PresetKeyframe extends Omit<Keyframe, "id"> {}

export interface UserEffectTemplate {
  type: string;
  enabled: boolean;
  parameters: Record<string, number>;
  parameterKeyframes?: Record<string, PresetKeyframe[]>;
  mask?: EffectMask;
}

const STORAGE_KEY = "aster.user-effect-presets.v1";
const MAX_PRESETS = 24;
const MAX_EFFECTS = 64;
const MAX_KEYFRAMES = 256;
const MAX_DOCUMENT_LENGTH = 1_000_000;

export function createUserEffectPreset(
  name: string,
  effects: Effect[],
  now = new Date(),
): UserEffectPreset {
  const normalizedName = name.trim().slice(0, 64);
  if (!normalizedName) throw new Error("Enter a preset name");
  if (effects.length === 0) throw new Error("The selected layer has no effects");
  if (effects.length > MAX_EFFECTS)
    throw new Error(`A preset supports up to ${MAX_EFFECTS} effects`);
  if (effects.some((effect) => effect.resource))
    throw new Error(
      "Embedded LUT resources stay project-bound and cannot be saved in a local preset",
    );
  return {
    id: createId(),
    name: normalizedName,
    createdAt: now.toISOString(),
    effects: effects.map(effectToTemplate),
  };
}

export function addUserEffectPreset(
  presets: UserEffectPreset[],
  preset: UserEffectPreset,
): UserEffectPreset[] {
  return [preset, ...presets.filter((entry) => entry.id !== preset.id)].slice(0, MAX_PRESETS);
}

export function removeUserEffectPreset(
  presets: UserEffectPreset[],
  presetId: string,
): UserEffectPreset[] {
  return presets.filter((preset) => preset.id !== presetId);
}

export function createEffectsFromUserPreset(preset: UserEffectPreset): Effect[] {
  return preset.effects.map((template) => {
    const effect = createEffect(template.type);
    effect.enabled = template.enabled;
    effect.parameters = { ...template.parameters };
    if (template.mask) effect.mask = structuredClone(template.mask);
    if (template.parameterKeyframes) {
      effect.parameterKeyframes = Object.fromEntries(
        Object.entries(template.parameterKeyframes).map(([parameter, keyframes]) => [
          parameter,
          keyframes.map((keyframe) => ({ ...keyframe, id: createId() })),
        ]),
      );
    }
    return effect;
  });
}

export function readUserEffectPresets(
  storage: Pick<Storage, "getItem"> | undefined,
): UserEffectPreset[] {
  if (!storage) return [];
  try {
    const document = storage.getItem(STORAGE_KEY);
    if (!document || document.length > MAX_DOCUMENT_LENGTH) return [];
    const parsed: unknown = JSON.parse(document);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .slice(0, MAX_PRESETS)
      .map(sanitizePreset)
      .filter((preset): preset is UserEffectPreset => preset !== undefined);
  } catch {
    return [];
  }
}

export function writeUserEffectPresets(
  storage: Pick<Storage, "setItem"> | undefined,
  presets: UserEffectPreset[],
): void {
  try {
    const document = JSON.stringify(presets.slice(0, MAX_PRESETS));
    if (document.length <= MAX_DOCUMENT_LENGTH) storage?.setItem(STORAGE_KEY, document);
  } catch {
    // User preferences must never interrupt editing or rendering.
  }
}

function effectToTemplate(effect: Effect): UserEffectTemplate {
  const definition = EFFECT_BY_TYPE.get(effect.type);
  if (!definition) throw new Error(`Unknown effect type: ${effect.type}`);
  const parameterKeys = new Set(definition.parameters.map((parameter) => parameter.key));
  const parameterKeyframes = Object.fromEntries(
    Object.entries(effect.parameterKeyframes ?? {})
      .filter(([parameter, keyframes]) => parameterKeys.has(parameter) && keyframes.length > 0)
      .map(([parameter, keyframes]) => [
        parameter,
        keyframes.slice(0, MAX_KEYFRAMES).map(({ id: _id, ...keyframe }) => keyframe),
      ]),
  );
  return {
    type: effect.type,
    enabled: effect.enabled,
    parameters: Object.fromEntries(
      Object.entries(effect.parameters).filter(
        ([key, value]) => parameterKeys.has(key) && Number.isFinite(value),
      ),
    ),
    ...(Object.keys(parameterKeyframes).length > 0 ? { parameterKeyframes } : {}),
    ...(effect.mask ? { mask: structuredClone(effect.mask) } : {}),
  };
}

function sanitizePreset(value: unknown): UserEffectPreset | undefined {
  if (!isRecord(value)) return undefined;
  const name = typeof value.name === "string" ? value.name.trim().slice(0, 64) : "";
  const createdAt = typeof value.createdAt === "string" ? value.createdAt : "";
  if (
    typeof value.id !== "string" ||
    value.id.length > 128 ||
    !name ||
    !Number.isFinite(Date.parse(createdAt)) ||
    !Array.isArray(value.effects) ||
    value.effects.length === 0 ||
    value.effects.length > MAX_EFFECTS
  )
    return undefined;
  const effects = value.effects.map(sanitizeTemplate);
  if (effects.some((effect) => effect === undefined)) return undefined;
  return { id: value.id, name, createdAt, effects: effects as UserEffectTemplate[] };
}

function sanitizeTemplate(value: unknown): UserEffectTemplate | undefined {
  if (!isRecord(value) || typeof value.type !== "string") return undefined;
  const definition = EFFECT_BY_TYPE.get(value.type);
  if (!definition || !isRecord(value.parameters)) return undefined;
  const effect = createEffect(value.type);
  for (const parameter of definition.parameters) {
    const requested = value.parameters[parameter.key];
    if (typeof requested === "number" && Number.isFinite(requested))
      effect.parameters[parameter.key] = clamp(requested, parameter.min, parameter.max);
  }
  const parameterKeyframes: Record<string, PresetKeyframe[]> = {};
  if (isRecord(value.parameterKeyframes)) {
    for (const parameter of definition.parameters) {
      const requested = value.parameterKeyframes[parameter.key];
      if (!Array.isArray(requested)) continue;
      parameterKeyframes[parameter.key] = requested
        .slice(0, MAX_KEYFRAMES)
        .map((keyframe) => sanitizeKeyframe(keyframe, parameter.min, parameter.max))
        .filter((keyframe): keyframe is PresetKeyframe => keyframe !== undefined)
        .sort((a, b) => a.time - b.time);
    }
  }
  const mask = sanitizeMask(value.mask);
  return {
    type: value.type,
    enabled: typeof value.enabled === "boolean" ? value.enabled : true,
    parameters: effect.parameters,
    ...(Object.values(parameterKeyframes).some((keyframes) => keyframes.length > 0)
      ? { parameterKeyframes }
      : {}),
    ...(mask ? { mask } : {}),
  };
}

function sanitizeKeyframe(
  value: unknown,
  minimum?: number,
  maximum?: number,
): PresetKeyframe | undefined {
  if (!isRecord(value)) return undefined;
  if (
    typeof value.time !== "number" ||
    !Number.isFinite(value.time) ||
    Math.abs(value.time) > 1_000_000 ||
    typeof value.value !== "number" ||
    !Number.isFinite(value.value) ||
    !["linear", "step", "bezier"].includes(String(value.interpolation))
  )
    return undefined;
  const easing =
    Array.isArray(value.easing) &&
    value.easing.length === 4 &&
    value.easing.every((entry) => typeof entry === "number" && Number.isFinite(entry))
      ? (value.easing as [number, number, number, number])
      : undefined;
  return {
    time: value.time,
    value: clamp(value.value, minimum, maximum),
    interpolation: value.interpolation as PresetKeyframe["interpolation"],
    ...(easing ? { easing } : {}),
  };
}

function sanitizeMask(value: unknown): EffectMask | undefined {
  if (!isRecord(value)) return undefined;
  if (
    !["ellipse", "rectangle"].includes(String(value.shape)) ||
    !numberPair(value.center, -1_000, 1_000) ||
    !numberPair(value.size, 0.001, 2_000) ||
    typeof value.feather !== "number" ||
    !Number.isFinite(value.feather) ||
    value.feather < 0 ||
    value.feather > 8_000 ||
    typeof value.opacity !== "number" ||
    !Number.isFinite(value.opacity) ||
    value.opacity < 0 ||
    value.opacity > 100 ||
    typeof value.invert !== "boolean"
  )
    return undefined;
  return {
    shape: value.shape as EffectMask["shape"],
    center: value.center as [number, number],
    size: value.size as [number, number],
    feather: value.feather,
    opacity: value.opacity,
    invert: value.invert,
  };
}

function numberPair(value: unknown, minimum: number, maximum: number): value is [number, number] {
  return (
    Array.isArray(value) &&
    value.length === 2 &&
    value.every(
      (entry) =>
        typeof entry === "number" && Number.isFinite(entry) && entry >= minimum && entry <= maximum,
    )
  );
}

function clamp(value: number, minimum?: number, maximum?: number): number {
  return Math.max(minimum ?? -Infinity, Math.min(maximum ?? Infinity, value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
