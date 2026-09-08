import { createGeneratorLayerForComposition } from "../layers/layer-factory";
import type {
  Composition,
  Layer,
  SceneGeneratorInstance,
  SceneGeneratorParameterValue,
} from "../types";
import {
  createDefaultParticleSettings,
  normalizeParticleSettings,
  type ParticleSettings,
} from "./particle-settings";
import { SCENE_GENERATOR_API_VERSION } from "./scene-generator";

export const BUILTIN_PARTICLE_PLUGIN_ID = "org.aster.builtin.particles";
export const BUILTIN_PARTICLE_NODE_TYPE = "particle_system";
export const BUILTIN_PARTICLE_API_VERSION = SCENE_GENERATOR_API_VERSION;

export function createParticleSceneGenerator(
  settings: ParticleSettings = createDefaultParticleSettings(),
): SceneGeneratorInstance {
  const normalized = normalizeParticleSettings(settings);
  return {
    pluginId: BUILTIN_PARTICLE_PLUGIN_ID,
    nodeType: BUILTIN_PARTICLE_NODE_TYPE,
    apiVersion: BUILTIN_PARTICLE_API_VERSION,
    parameters: {
      renderMode: normalized.renderMode,
      meshPrimitive: normalized.meshPrimitive,
      count: normalized.count,
      seed: normalized.seed,
      lifetime: normalized.lifetime,
      emitterShape: normalized.emitterShape,
      emitterPosition: normalized.emitterPosition,
      emitterSize: normalized.emitterSize,
      emitterSpread: normalized.emitterSpread,
      velocity: normalized.velocity,
      gravity: normalized.gravity,
      drag: normalized.drag,
      turbulence: normalized.turbulence,
      turbulenceScale: normalized.turbulenceScale,
      startColor: normalized.startColor,
      endColor: normalized.endColor,
      startOpacity: normalized.startOpacity,
      endOpacity: normalized.endOpacity,
      startSize: normalized.startSize,
      endSize: normalized.endSize,
      startRotation: normalized.startRotation,
      endRotation: normalized.endRotation,
      streakLength: normalized.streakLength,
    },
  };
}

export function createParticleLayerForComposition(
  composition: Composition,
  currentTime = 0,
): Layer {
  const layer = createGeneratorLayerForComposition(
    composition,
    createParticleSceneGenerator(),
    currentTime,
    "Particles",
  );
  layer.blendMode = "add";
  return layer;
}

export function particleSettingsFromGenerator(
  generator: SceneGeneratorInstance | undefined,
): ParticleSettings | undefined {
  if (
    !generator ||
    generator.pluginId !== BUILTIN_PARTICLE_PLUGIN_ID ||
    generator.nodeType !== BUILTIN_PARTICLE_NODE_TYPE
  )
    return undefined;
  const fallback = createDefaultParticleSettings();
  const parameter = generator.parameters;
  return normalizeParticleSettings({
    renderMode: stringChoice(
      parameter.renderMode,
      ["billboard", "streak", "mesh"],
      fallback.renderMode,
    ),
    meshPrimitive: "cube",
    count: numberValue(parameter.count, fallback.count),
    seed: numberValue(parameter.seed, fallback.seed),
    lifetime: numberValue(parameter.lifetime, fallback.lifetime),
    emitterShape: stringChoice(
      parameter.emitterShape,
      ["point", "box", "sphere", "ring", "line"],
      fallback.emitterShape,
    ),
    emitterPosition: vector3(parameter.emitterPosition, fallback.emitterPosition),
    emitterSize: vector3(parameter.emitterSize, fallback.emitterSize),
    emitterSpread: numberValue(parameter.emitterSpread, fallback.emitterSpread),
    velocity: vector3(parameter.velocity, fallback.velocity),
    gravity: vector3(parameter.gravity, fallback.gravity),
    drag: numberValue(parameter.drag, fallback.drag),
    turbulence: numberValue(parameter.turbulence, fallback.turbulence),
    turbulenceScale: numberValue(parameter.turbulenceScale, fallback.turbulenceScale),
    startColor: vector3(parameter.startColor, fallback.startColor),
    endColor: vector3(parameter.endColor, fallback.endColor),
    startOpacity: numberValue(parameter.startOpacity, fallback.startOpacity),
    endOpacity: numberValue(parameter.endOpacity, fallback.endOpacity),
    startSize: numberValue(parameter.startSize, fallback.startSize),
    endSize: numberValue(parameter.endSize, fallback.endSize),
    startRotation: numberValue(parameter.startRotation, fallback.startRotation),
    endRotation: numberValue(parameter.endRotation, fallback.endRotation),
    streakLength: numberValue(parameter.streakLength, fallback.streakLength),
  });
}

function numberValue(value: SceneGeneratorParameterValue | undefined, fallback: number): number {
  return typeof value === "number" ? value : fallback;
}

function vector3(
  value: SceneGeneratorParameterValue | undefined,
  fallback: [number, number, number],
): [number, number, number] {
  return Array.isArray(value) && value.length === 3 ? [value[0], value[1], value[2]] : fallback;
}

function stringChoice<const Value extends string>(
  value: SceneGeneratorParameterValue | undefined,
  choices: readonly Value[],
  fallback: Value,
): Value {
  return typeof value === "string" && choices.includes(value as Value)
    ? (value as Value)
    : fallback;
}
