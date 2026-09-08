import {
  requireFiniteNumber,
  requireObject,
  requirePositiveNumber,
  requireString,
  validateKeyframeHandles,
} from "./values";

export function validateEffect(value: unknown, path: string): void {
  const effect = requireObject(value, path);
  requireString(effect.id, `${path}.id`);
  requireString(effect.type, `${path}.type`);
  requireString(effect.name, `${path}.name`);
  if (typeof effect.enabled !== "boolean") throw new Error(`${path}.enabled must be a boolean`);
  const parameters = requireObject(effect.parameters, `${path}.parameters`);
  for (const [key, parameter] of Object.entries(parameters))
    if (typeof parameter !== "number" || !Number.isFinite(parameter))
      throw new Error(`${path}.parameters.${key} must be finite`);
  if (effect.parameterKeyframes !== undefined) {
    const tracks = requireObject(effect.parameterKeyframes, `${path}.parameterKeyframes`);
    for (const [parameter, value] of Object.entries(tracks)) {
      if (!Array.isArray(value) || value.length > 10_000)
        throw new Error(`${path}.parameterKeyframes.${parameter} must be a bounded array`);
      let previousTime = -Infinity;
      const keyframeIds = new Set<string>();
      for (const [index, keyframeValue] of value.entries()) {
        const keyframe = requireObject(
          keyframeValue,
          `${path}.parameterKeyframes.${parameter}[${index}]`,
        );
        const id = requireString(
          keyframe.id,
          `${path}.parameterKeyframes.${parameter}[${index}].id`,
        );
        if (keyframeIds.has(id))
          throw new Error(`${path}.parameterKeyframes.${parameter} contains a duplicate id`);
        keyframeIds.add(id);
        const time = requireFiniteNumber(
          keyframe.time,
          `${path}.parameterKeyframes.${parameter}[${index}].time`,
        );
        requireFiniteNumber(
          keyframe.value,
          `${path}.parameterKeyframes.${parameter}[${index}].value`,
        );
        if (time < 0 || time <= previousTime)
          throw new Error(`${path}.parameterKeyframes.${parameter} must be strictly sorted`);
        if (!["linear", "step", "bezier"].includes(String(keyframe.interpolation)))
          throw new Error(`${path}.parameterKeyframes.${parameter} has invalid interpolation`);
        if (
          keyframe.easing !== undefined &&
          (!Array.isArray(keyframe.easing) ||
            keyframe.easing.length !== 4 ||
            keyframe.easing.some(
              (channel) => typeof channel !== "number" || !Number.isFinite(channel),
            ))
        )
          throw new Error(`${path}.parameterKeyframes.${parameter} has invalid easing`);
        validateKeyframeHandles(keyframe, `${path}.parameterKeyframes.${parameter}[${index}]`);
        previousTime = time;
      }
    }
  }
  if (effect.mask !== undefined) validateEffectMask(effect.mask, `${path}.mask`);
  if (effect.resource !== undefined) validateLutResource(effect.resource, `${path}.resource`);
}

function validateEffectMask(value: unknown, path: string): void {
  const mask = requireObject(value, path);
  if (mask.shape !== "ellipse" && mask.shape !== "rectangle" && mask.shape !== "path")
    throw new Error(`${path}.shape must be ellipse, rectangle, or path`);
  if (mask.shape === "path") requireString(mask.pathId, `${path}.pathId`);
  else if (mask.pathId !== undefined)
    throw new Error(`${path}.pathId is only valid for path masks`);
  if (!Array.isArray(mask.center) || mask.center.length !== 2)
    throw new Error(`${path}.center must contain two values`);
  if (!Array.isArray(mask.size) || mask.size.length !== 2)
    throw new Error(`${path}.size must contain two values`);
  for (const [index, channel] of mask.center.entries()) {
    const value = requireFiniteNumber(channel, `${path}.center[${index}]`);
    if (value < -1000 || value > 1000) throw new Error(`${path}.center is out of range`);
  }
  for (const [index, channel] of mask.size.entries()) {
    const value = requirePositiveNumber(channel, `${path}.size[${index}]`);
    if (value > 2000) throw new Error(`${path}.size is out of range`);
  }
  const feather = requireFiniteNumber(mask.feather, `${path}.feather`);
  if (feather < 0 || feather > 8000) throw new Error(`${path}.feather is out of range`);
  const opacity = requireFiniteNumber(mask.opacity, `${path}.opacity`);
  if (opacity < 0 || opacity > 100) throw new Error(`${path}.opacity is out of range`);
  if (typeof mask.invert !== "boolean") throw new Error(`${path}.invert must be a boolean`);
}

function validateLutResource(value: unknown, path: string): void {
  const resource = requireObject(value, path);
  if (resource.kind !== "lut3d") throw new Error(`${path}.kind must be lut3d`);
  if (requireString(resource.name, `${path}.name`).length > 160)
    throw new Error(`${path}.name is too long`);
  if (!/^[a-f0-9]{8}$/.test(requireString(resource.checksum, `${path}.checksum`)))
    throw new Error(`${path}.checksum is invalid`);
  const size = requirePositiveNumber(resource.size, `${path}.size`);
  if (!Number.isInteger(size) || size > 64)
    throw new Error(`${path}.size must be an integer at most 64`);
  if (!Array.isArray(resource.data) || resource.data.length !== size ** 3 * 3)
    throw new Error(`${path}.data has an invalid length`);
  if (
    resource.data.some(
      (channel) =>
        typeof channel !== "number" || !Number.isFinite(channel) || Math.abs(channel) > 64,
    )
  )
    throw new Error(`${path}.data must contain bounded finite channels`);
  for (const field of ["domainMin", "domainMax"] as const) {
    if (!Array.isArray(resource[field]) || resource[field].length !== 3)
      throw new Error(`${path}.${field} must contain three channels`);
    if (
      resource[field].some(
        (channel) =>
          typeof channel !== "number" || !Number.isFinite(channel) || Math.abs(channel) > 64,
      )
    )
      throw new Error(`${path}.${field} must contain bounded finite channels`);
  }
  for (let channel = 0; channel < 3; channel += 1)
    if ((resource.domainMax as number[])[channel] <= (resource.domainMin as number[])[channel])
      throw new Error(`${path} has an invalid domain`);
}
