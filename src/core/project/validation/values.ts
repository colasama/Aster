import { CAMERA_PROPERTY_LIMITS, type CameraAnimatableField } from "../../scene/camera-properties";

export function validateUniqueBoundedId(value: unknown, path: string, ids: Set<string>): void {
  const id = requireString(value, path);
  if (!id || id.length > 256 || ids.has(id)) throw new Error(`${path} must be unique and bounded`);
  ids.add(id);
}

export function validateInteger(
  value: unknown,
  path: string,
  bounds: readonly [number, number],
): void {
  const number = requireFiniteNumber(value, path);
  if (!Number.isSafeInteger(number) || number < bounds[0] || number > bounds[1])
    throw new Error(`${path} must be an integer from ${bounds[0]} through ${bounds[1]}`);
}

export function validateBoundedAnimatable(
  value: unknown,
  path: string,
  bounds: readonly [number, number],
): void {
  validateAnimatable(value, path);
  const property = value as
    | { mode: "static"; value: number }
    | { mode: "animated"; keyframes: Array<{ value: number }> };
  const values =
    property.mode === "static"
      ? [property.value]
      : property.keyframes.map((keyframe) => keyframe.value);
  if (values.some((number) => number < bounds[0] || number > bounds[1]))
    throw new Error(`${path} values must be between ${bounds[0]} and ${bounds[1]}`);
}

export function validateBoundedNumber(
  value: unknown,
  path: string,
  bounds: readonly [number, number],
): void {
  const number = requireFiniteNumber(value, path);
  if (number < bounds[0] || number > bounds[1])
    throw new Error(`${path} must be between ${bounds[0]} and ${bounds[1]}`);
}

export function validateTransform(value: unknown, path: string): void {
  const transform = requireObject(value, path);
  for (const field of ["position", "rotation", "scale", "anchor"] as const) {
    if (!Array.isArray(transform[field]) || transform[field].length !== 3)
      throw new Error(`${path}.${field} must contain three animated properties`);
    for (const [index, property] of transform[field].entries())
      validateAnimatable(property, `${path}.${field}[${index}]`);
  }
  validateAnimatable(transform.opacity, `${path}.opacity`);
}

export function validateBezierPath(value: unknown, path: string): void {
  const bezier = requireObject(value, path);
  if (typeof bezier.closed !== "boolean") throw new Error(`${path}.closed must be a boolean`);
  if (!Array.isArray(bezier.vertices) || bezier.vertices.length < 2 || bezier.vertices.length > 512)
    throw new Error(`${path}.vertices must contain between 2 and 512 anchors`);
  for (const [index, value] of bezier.vertices.entries()) {
    const vertex = requireObject(value, `${path}.vertices[${index}]`);
    for (const field of ["position", "inTangent", "outTangent"] as const) {
      const point = requireNumberArray(vertex[field], `${path}.vertices[${index}].${field}`, 2);
      if (point.length !== 2 || point.some((channel) => Math.abs(channel) > 16))
        throw new Error(`${path}.vertices[${index}].${field} is out of range`);
    }
  }
}

export function validateAnimatable(value: unknown, path: string): void {
  const property = requireObject(value, path);
  if (property.mode === "static") {
    requireFiniteNumber(property.value, `${path}.value`);
    return;
  }
  if (property.mode !== "animated" || !Array.isArray(property.keyframes))
    throw new Error(`${path} must be a static or animated property`);
  if (property.keyframes.length > 10_000) throw new Error(`${path}.keyframes must be bounded`);
  let previousTime = -Infinity;
  const ids = new Set<string>();
  for (const [index, value] of property.keyframes.entries()) {
    const keyframe = requireObject(value, `${path}.keyframes[${index}]`);
    const id = requireString(keyframe.id, `${path}.keyframes[${index}].id`);
    if (ids.has(id)) throw new Error(`${path}.keyframes contains duplicate id ${id}`);
    ids.add(id);
    const time = requireFiniteNumber(keyframe.time, `${path}.keyframes[${index}].time`);
    requireFiniteNumber(keyframe.value, `${path}.keyframes[${index}].value`);
    if (time < 0 || time <= previousTime) throw new Error(`${path}.keyframes must be sorted`);
    if (!["linear", "step", "bezier"].includes(String(keyframe.interpolation)))
      throw new Error(`${path}.keyframes has invalid interpolation`);
    validateKeyframeHandles(keyframe, `${path}.keyframes[${index}]`);
    previousTime = time;
  }
}

export function validateBoundedCameraProperty(
  value: unknown,
  path: string,
  field: CameraAnimatableField,
): void {
  validateAnimatable(value, path);
  const property = value as {
    mode: "static" | "animated";
    value?: number;
    keyframes?: Array<{ value: number }>;
  };
  const limit = CAMERA_PROPERTY_LIMITS[field];
  const values =
    property.mode === "static"
      ? [property.value]
      : (property.keyframes ?? []).map((keyframe) => keyframe.value);
  for (const [index, entry] of values.entries()) {
    const valuePath =
      property.mode === "static" ? `${path}.value` : `${path}.keyframes[${index}].value`;
    validateBoundedNumber(entry, valuePath, [limit.minimum, limit.maximum]);
  }
}

export function validateKeyframeHandles(keyframe: Record<string, unknown>, path: string): void {
  if (
    keyframe.easing !== undefined &&
    (!Array.isArray(keyframe.easing) ||
      keyframe.easing.length !== 4 ||
      keyframe.easing.some((channel) => typeof channel !== "number" || !Number.isFinite(channel)))
  )
    throw new Error(`${path}.easing must contain four finite values`);
  for (const field of ["spatialIn", "spatialOut"] as const)
    if (
      keyframe[field] !== undefined &&
      (typeof keyframe[field] !== "number" || !Number.isFinite(keyframe[field]))
    )
      throw new Error(`${path}.${field} must be finite`);
}

export function requireObject(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`${path} must be an object`);
  return value as Record<string, unknown>;
}

export function requireString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${path} must be a string`);
  return value;
}

export function requirePositiveNumber(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0)
    throw new Error(`${path} must be a positive number`);
  return value;
}

export function requireFiniteNumber(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value))
    throw new Error(`${path} must be a finite number`);
  return value;
}

export function requireNumberArray(value: unknown, path: string, maximumLength: number): number[] {
  if (!Array.isArray(value) || value.length > maximumLength)
    throw new Error(`${path} must be a bounded number array`);
  if (value.some((entry) => typeof entry !== "number" || !Number.isFinite(entry)))
    throw new Error(`${path} must contain finite numbers`);
  return value as number[];
}
