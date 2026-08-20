import type { EvaluatedTransform, Id } from "./types";

export const MAX_CLONER_INSTANCES = 65_536;
export const CLONER_INSTANCE_FLOATS = 16;

export const CLONER_INSTANCE_OFFSETS = {
  position: 0,
  rotation: 4,
  scale: 8,
  metadata: 12,
} as const;

export interface GridClonerDistribution {
  kind: "grid";
  count: [number, number, number];
  spacing: [number, number, number];
}

export interface RadialClonerDistribution {
  kind: "radial";
  count: number;
  radius: number;
  startAngle: number;
  endAngle: number;
  axis: "x" | "y" | "z";
  alignRotation: boolean;
}

interface ClonerEffectorBase {
  id: Id;
  enabled: boolean;
  strength: number;
}

export interface RandomClonerEffector extends ClonerEffectorBase {
  kind: "random";
  seed: number;
  position: [number, number, number];
  scale: [number, number, number];
  rotation: [number, number, number];
}

export interface PositionClonerEffector extends ClonerEffectorBase {
  kind: "position";
  value: [number, number, number];
}

export interface ScaleClonerEffector extends ClonerEffectorBase {
  kind: "scale";
  /** Target scale in percent, blended from 100% by strength. */
  value: [number, number, number];
}

export interface RotationClonerEffector extends ClonerEffectorBase {
  kind: "rotation";
  value: [number, number, number];
}

export type ClonerEffector =
  | RandomClonerEffector
  | PositionClonerEffector
  | ScaleClonerEffector
  | RotationClonerEffector;

export interface ClonerSettings {
  distribution: GridClonerDistribution | RadialClonerDistribution;
  effectors: ClonerEffector[];
}

export interface ClonerInstance {
  index: number;
  position: [number, number, number];
  rotation: [number, number, number];
  /** Percent scale, matching the editor transform convention. */
  scale: [number, number, number];
}

export interface ClonerEvaluation {
  instances: ClonerInstance[];
  /**
   * GPU-ready vec4-aligned records: position, Euler rotation in radians,
   * unit scale, then index/normalized index/stable random/active flag.
   */
  instanceData: Float32Array;
}

export function normalizeClonerSettings(settings: ClonerSettings): ClonerSettings {
  return {
    distribution:
      settings.distribution.kind === "grid"
        ? {
            kind: "grid",
            count: boundedGridCount(settings.distribution.count),
            spacing: boundedVector(settings.distribution.spacing),
          }
        : {
            kind: "radial",
            count: boundedCount(settings.distribution.count),
            radius: Math.abs(boundedFinite(settings.distribution.radius)),
            startAngle: boundedFinite(settings.distribution.startAngle),
            endAngle: boundedFinite(settings.distribution.endAngle),
            axis: ["x", "y", "z"].includes(settings.distribution.axis)
              ? settings.distribution.axis
              : "z",
            alignRotation: settings.distribution.alignRotation === true,
          },
    effectors: settings.effectors.slice(0, 32).map(normalizeEffector),
  };
}

export function validateClonerSettings(
  value: unknown,
  path = "cloner",
): asserts value is ClonerSettings {
  const cloner = objectValue(value, path);
  const distribution = objectValue(cloner.distribution, `${path}.distribution`);
  if (distribution.kind === "grid") {
    const count = vectorValue(distribution.count, `${path}.distribution.count`);
    const integerCount = count.map((entry, axis) => {
      if (!Number.isInteger(entry) || entry < 1 || entry > 512)
        throw new Error(`${path}.distribution.count[${axis}] must be an integer from 1 to 512`);
      return entry;
    });
    if (integerCount.reduce((product, entry) => product * entry, 1) > MAX_CLONER_INSTANCES)
      throw new Error(`${path}.distribution grid exceeds ${MAX_CLONER_INSTANCES} instances`);
    boundedVectorValue(distribution.spacing, `${path}.distribution.spacing`);
  } else if (distribution.kind === "radial") {
    const count = finiteValue(distribution.count, `${path}.distribution.count`);
    if (!Number.isInteger(count) || count < 1 || count > MAX_CLONER_INSTANCES)
      throw new Error(
        `${path}.distribution.count must be an integer from 1 to ${MAX_CLONER_INSTANCES}`,
      );
    for (const field of ["radius", "startAngle", "endAngle"] as const)
      boundedFiniteValue(distribution[field], `${path}.distribution.${field}`);
    if ((distribution.radius as number) < 0)
      throw new Error(`${path}.distribution.radius must not be negative`);
    if (!(["x", "y", "z"] as unknown[]).includes(distribution.axis))
      throw new Error(`${path}.distribution.axis is invalid`);
    if (typeof distribution.alignRotation !== "boolean")
      throw new Error(`${path}.distribution.alignRotation must be a boolean`);
  } else {
    throw new Error(`${path}.distribution.kind is invalid`);
  }
  if (!Array.isArray(cloner.effectors) || cloner.effectors.length > 32)
    throw new Error(`${path}.effectors must be an array of at most 32 effectors`);
  for (const [index, candidate] of cloner.effectors.entries())
    validateEffector(candidate, `${path}.effectors[${index}]`);
}

export function evaluateCloner(settings: ClonerSettings, _time = 0): ClonerEvaluation {
  const instances = distributionInstances(settings.distribution);
  for (const effector of settings.effectors.slice(0, 32)) {
    if (!effector.enabled || !Number.isFinite(effector.strength) || effector.strength === 0)
      continue;
    for (const instance of instances) applyEffector(instance, effector);
  }
  return { instances, instanceData: packClonerInstances(instances) };
}

export function composeClonerTransform(
  source: EvaluatedTransform,
  instance: ClonerInstance,
): EvaluatedTransform {
  const offset = rotateVector(
    [
      (instance.position[0] * source.scale[0]) / 100,
      (instance.position[1] * source.scale[1]) / 100,
      (instance.position[2] * source.scale[2]) / 100,
    ],
    source.rotation,
  );
  return {
    position: source.position.map((value, axis) => value + offset[axis]) as [
      number,
      number,
      number,
    ],
    rotation: source.rotation.map((value, axis) => value + instance.rotation[axis]) as [
      number,
      number,
      number,
    ],
    scale: source.scale.map((value, axis) => (value * instance.scale[axis]) / 100) as [
      number,
      number,
      number,
    ],
    anchor: source.anchor,
    opacity: source.opacity,
  };
}

export function packClonerInstances(instances: readonly ClonerInstance[]): Float32Array {
  const data = new Float32Array(instances.length * CLONER_INSTANCE_FLOATS);
  const divisor = Math.max(1, instances.length - 1);
  for (const [recordIndex, instance] of instances.entries()) {
    const offset = recordIndex * CLONER_INSTANCE_FLOATS;
    data.set(instance.position, offset + CLONER_INSTANCE_OFFSETS.position);
    data.set(instance.rotation.map(toRadians), offset + CLONER_INSTANCE_OFFSETS.rotation);
    data.set(
      instance.scale.map((value) => value / 100),
      offset + CLONER_INSTANCE_OFFSETS.scale,
    );
    data.set(
      [instance.index, recordIndex / divisor, randomUnit(0x41_53_54_52, instance.index, 0), 1],
      offset + CLONER_INSTANCE_OFFSETS.metadata,
    );
  }
  return data;
}

function distributionInstances(distribution: ClonerSettings["distribution"]): ClonerInstance[] {
  return distribution.kind === "grid" ? gridInstances(distribution) : radialInstances(distribution);
}

function gridInstances(distribution: GridClonerDistribution): ClonerInstance[] {
  const count = distribution.count.map(boundedAxisCount) as [number, number, number];
  const center = count.map((value, axis) => ((value - 1) * finite(distribution.spacing[axis])) / 2);
  const instances: ClonerInstance[] = [];
  for (let z = 0; z < count[2]; z += 1) {
    for (let y = 0; y < count[1]; y += 1) {
      for (let x = 0; x < count[0]; x += 1) {
        if (instances.length >= MAX_CLONER_INSTANCES) return instances;
        instances.push({
          index: instances.length,
          position: [
            x * finite(distribution.spacing[0]) - center[0],
            y * finite(distribution.spacing[1]) - center[1],
            z * finite(distribution.spacing[2]) - center[2],
          ],
          rotation: [0, 0, 0],
          scale: [100, 100, 100],
        });
      }
    }
  }
  return instances;
}

function radialInstances(distribution: RadialClonerDistribution): ClonerInstance[] {
  const count = boundedCount(distribution.count);
  const radius = finite(distribution.radius);
  const start = finite(distribution.startAngle);
  const end = finite(distribution.endAngle);
  const closed = Math.abs(end - start) >= 360 - 0.000_001;
  const denominator = count <= 1 ? 1 : closed ? count : count - 1;
  return Array.from({ length: count }, (_, index) => {
    const angle = start + ((end - start) * index) / denominator;
    const radians = toRadians(angle);
    const cosine = Math.cos(radians) * radius;
    const sine = Math.sin(radians) * radius;
    return {
      index,
      position:
        distribution.axis === "x"
          ? [0, cosine, sine]
          : distribution.axis === "y"
            ? [cosine, 0, sine]
            : [cosine, sine, 0],
      rotation: distribution.alignRotation
        ? distribution.axis === "x"
          ? [angle, 0, 0]
          : distribution.axis === "y"
            ? [0, angle, 0]
            : [0, 0, angle]
        : [0, 0, 0],
      scale: [100, 100, 100],
    } as ClonerInstance;
  });
}

function applyEffector(instance: ClonerInstance, effector: ClonerEffector): void {
  const strength = effector.strength;
  if (effector.kind === "position" || effector.kind === "rotation") {
    const target = effector.kind === "position" ? instance.position : instance.rotation;
    for (let axis = 0; axis < 3; axis += 1) target[axis] += finite(effector.value[axis]) * strength;
    return;
  }
  if (effector.kind === "scale") {
    for (let axis = 0; axis < 3; axis += 1) {
      const factor = 1 + (finite(effector.value[axis], 100) / 100 - 1) * strength;
      instance.scale[axis] = Math.max(0.001, instance.scale[axis] * factor);
    }
    return;
  }
  for (let axis = 0; axis < 3; axis += 1) {
    instance.position[axis] +=
      randomSigned(effector.seed, instance.index, axis) *
      Math.abs(finite(effector.position[axis])) *
      strength;
    instance.scale[axis] = Math.max(
      0.001,
      instance.scale[axis] *
        (1 +
          (randomSigned(effector.seed, instance.index, axis + 3) *
            Math.abs(finite(effector.scale[axis])) *
            strength) /
            100),
    );
    instance.rotation[axis] +=
      randomSigned(effector.seed, instance.index, axis + 6) *
      Math.abs(finite(effector.rotation[axis])) *
      strength;
  }
}

function normalizeEffector(effector: ClonerEffector): ClonerEffector {
  const common = {
    id: effector.id,
    enabled: effector.enabled,
    strength: Math.max(-10, Math.min(10, finite(effector.strength))),
  };
  if (effector.kind === "random")
    return {
      ...common,
      kind: "random",
      seed: Math.max(0, Math.min(0xff_ff_ff_ff, Math.trunc(finite(effector.seed)))),
      position: boundedVector(effector.position, true),
      scale: boundedVector(effector.scale, true),
      rotation: boundedVector(effector.rotation, true),
    };
  if (effector.kind === "scale")
    return {
      ...common,
      kind: "scale",
      value: effector.value.map((value) =>
        Math.max(0.001, Math.min(10_000, finite(value, 100))),
      ) as [number, number, number],
    };
  return { ...common, kind: effector.kind, value: boundedVector(effector.value) };
}

function validateEffector(value: unknown, path: string): void {
  const effector = objectValue(value, path);
  if (typeof effector.id !== "string" || effector.id.length === 0)
    throw new Error(`${path}.id must be a non-empty string`);
  if (typeof effector.enabled !== "boolean") throw new Error(`${path}.enabled must be a boolean`);
  const strength = finiteValue(effector.strength, `${path}.strength`);
  if (strength < -10 || strength > 10) throw new Error(`${path}.strength is out of range`);
  if (effector.kind === "random") {
    const seed = finiteValue(effector.seed, `${path}.seed`);
    if (!Number.isInteger(seed) || seed < 0 || seed > 0xff_ff_ff_ff)
      throw new Error(`${path}.seed must be a bounded non-negative integer`);
    for (const field of ["position", "scale", "rotation"] as const) {
      const vector = boundedVectorValue(effector[field], `${path}.${field}`);
      if (vector.some((entry) => entry < 0))
        throw new Error(`${path}.${field} amplitudes must not be negative`);
    }
    return;
  }
  if (effector.kind !== "position" && effector.kind !== "scale" && effector.kind !== "rotation")
    throw new Error(`${path}.kind is invalid`);
  const vector = boundedVectorValue(effector.value, `${path}.value`);
  if (effector.kind === "scale" && vector.some((entry) => entry <= 0 || entry > 10_000))
    throw new Error(`${path}.value must contain scale percentages from 0 to 10000`);
}

function rotateVector(
  source: [number, number, number],
  rotation: [number, number, number],
): [number, number, number] {
  let [x, y, z] = source;
  const xRotation = toRadians(rotation[0]);
  const yRotation = toRadians(rotation[1]);
  const zRotation = toRadians(rotation[2]);
  [y, z] = [
    y * Math.cos(xRotation) - z * Math.sin(xRotation),
    y * Math.sin(xRotation) + z * Math.cos(xRotation),
  ];
  [x, z] = [
    x * Math.cos(yRotation) + z * Math.sin(yRotation),
    -x * Math.sin(yRotation) + z * Math.cos(yRotation),
  ];
  [x, y] = [
    x * Math.cos(zRotation) - y * Math.sin(zRotation),
    x * Math.sin(zRotation) + y * Math.cos(zRotation),
  ];
  return [x, y, z];
}

function randomSigned(seed: number, index: number, channel: number): number {
  return randomUnit(seed, index, channel) * 2 - 1;
}

function randomUnit(seed: number, index: number, channel: number): number {
  let value =
    Math.trunc(finite(seed)) ^
    Math.imul(index + 1, 0x9e_37_79_b1) ^
    Math.imul(channel + 1, 0x85_eb_ca_6b);
  value ^= value >>> 16;
  value = Math.imul(value, 0x7f_4a_7c_15);
  value ^= value >>> 15;
  value = Math.imul(value, 0x84_6c_a6_8b);
  value ^= value >>> 16;
  return (value >>> 0) / 0xff_ff_ff_ff;
}

function boundedAxisCount(value: number): number {
  return Math.min(512, boundedCount(value));
}

function boundedGridCount(value: readonly [number, number, number]): [number, number, number] {
  const count = value.map(boundedAxisCount) as [number, number, number];
  for (let axis = 2; axis >= 0; axis -= 1) {
    const otherAxes = count.reduce(
      (product, entry, entryAxis) => product * (entryAxis === axis ? 1 : entry),
      1,
    );
    count[axis] = Math.min(count[axis], Math.max(1, Math.floor(MAX_CLONER_INSTANCES / otherAxes)));
  }
  return count;
}

function boundedCount(value: number): number {
  return Math.max(1, Math.min(MAX_CLONER_INSTANCES, Math.trunc(finite(value, 1))));
}

function boundedVector(
  value: readonly [number, number, number],
  absolute = false,
): [number, number, number] {
  return value.map((entry) => {
    const bounded = boundedFinite(entry);
    return absolute ? Math.abs(bounded) : bounded;
  }) as [number, number, number];
}

function boundedFinite(value: number): number {
  return Math.max(-1_000_000, Math.min(1_000_000, finite(value)));
}

function objectValue(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`${path} must be an object`);
  return value as Record<string, unknown>;
}

function vectorValue(value: unknown, path: string): [number, number, number] {
  if (!Array.isArray(value) || value.length !== 3)
    throw new Error(`${path} must contain three numbers`);
  return value.map((entry, index) => finiteValue(entry, `${path}[${index}]`)) as [
    number,
    number,
    number,
  ];
}

function boundedVectorValue(value: unknown, path: string): [number, number, number] {
  const vector = vectorValue(value, path);
  if (vector.some((entry) => Math.abs(entry) > 1_000_000))
    throw new Error(`${path} values are out of range`);
  return vector;
}

function boundedFiniteValue(value: unknown, path: string): number {
  const finite = finiteValue(value, path);
  if (Math.abs(finite) > 1_000_000) throw new Error(`${path} is out of range`);
  return finite;
}

function finiteValue(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value))
    throw new Error(`${path} must be a finite number`);
  return value;
}

function finite(value: number, fallback = 0): number {
  return Number.isFinite(value) ? value : fallback;
}

function toRadians(degrees: number): number {
  return (degrees * Math.PI) / 180;
}
