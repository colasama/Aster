import type { SceneGeneratorInstance, SceneGeneratorParameterValue } from "./types";

export const SCENE_GENERATOR_API_VERSION = 1;
export const MAX_SCENE_GENERATOR_PARAMETERS = 128;

/** Validates the portable envelope without requiring the referenced plugin to be installed. */
export function assertSceneGeneratorInstance(
  value: unknown,
  path = "generator",
): asserts value is SceneGeneratorInstance {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`${path} must be an object`);
  const generator = value as Record<string, unknown>;
  for (const key of ["pluginId", "nodeType"])
    if (
      typeof generator[key] !== "string" ||
      generator[key].length === 0 ||
      generator[key].length > 128
    )
      throw new Error(`${path}.${key} must be a bounded non-empty string`);
  if (!Number.isInteger(generator.apiVersion) || Number(generator.apiVersion) < 1)
    throw new Error(`${path}.apiVersion must be a positive integer`);
  if (
    !generator.parameters ||
    typeof generator.parameters !== "object" ||
    Array.isArray(generator.parameters)
  )
    throw new Error(`${path}.parameters must be an object`);
  const parameters = Object.entries(generator.parameters as Record<string, unknown>);
  if (parameters.length > MAX_SCENE_GENERATOR_PARAMETERS)
    throw new Error(`${path}.parameters exceeds ${MAX_SCENE_GENERATOR_PARAMETERS} entries`);
  for (const [name, parameter] of parameters) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name))
      throw new Error(`${path}.parameters.${name} has an invalid name`);
    assertParameterValue(parameter, `${path}.parameters.${name}`);
  }
}

function assertParameterValue(
  value: unknown,
  path: string,
): asserts value is SceneGeneratorParameterValue {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`${path} must be finite`);
    return;
  }
  if (typeof value === "string") {
    if (value.length > 256) throw new Error(`${path} is too long`);
    return;
  }
  if (typeof value === "boolean") return;
  if (
    Array.isArray(value) &&
    value.length <= 16 &&
    value.every((channel) => typeof channel === "number" && Number.isFinite(channel))
  )
    return;
  throw new Error(`${path} has an unsupported value`);
}
