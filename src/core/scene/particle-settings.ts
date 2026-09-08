export interface ParticleSettings {
  renderMode: "billboard" | "streak" | "mesh";
  meshPrimitive: "cube";
  count: number;
  seed: number;
  lifetime: number;
  emitterShape: "point" | "box" | "sphere" | "ring" | "line";
  emitterPosition: [number, number, number];
  emitterSize: [number, number, number];
  emitterSpread: number;
  velocity: [number, number, number];
  gravity: [number, number, number];
  drag: number;
  turbulence: number;
  turbulenceScale: number;
  startColor: [number, number, number];
  endColor: [number, number, number];
  startOpacity: number;
  endOpacity: number;
  startSize: number;
  endSize: number;
  startRotation: number;
  endRotation: number;
  streakLength: number;
}

export const PARTICLE_LIMITS = {
  count: [1, 1_000_000],
  seed: [0, 16_777_215],
  lifetime: [0.05, 3_600],
  emitterPosition: [-4, 4],
  emitterSize: [0, 8],
  emitterSpread: [0, 180],
  velocity: [-10, 10],
  gravity: [-10, 10],
  drag: [0, 10],
  turbulence: [0, 10],
  turbulenceScale: [0.01, 100],
  color: [0, 16],
  opacity: [0, 1],
  size: [0.01, 256],
  rotation: [-36_000, 36_000],
  streakLength: [0.01, 5],
} as const;

export const PARTICLE_SETTING_KEYS = [
  "renderMode",
  "meshPrimitive",
  "count",
  "seed",
  "lifetime",
  "emitterShape",
  "emitterPosition",
  "emitterSize",
  "emitterSpread",
  "velocity",
  "gravity",
  "drag",
  "turbulence",
  "turbulenceScale",
  "startColor",
  "endColor",
  "startOpacity",
  "endOpacity",
  "startSize",
  "endSize",
  "startRotation",
  "endRotation",
  "streakLength",
] as const satisfies readonly (keyof ParticleSettings)[];

export function createDefaultParticleSettings(): ParticleSettings {
  return {
    renderMode: "billboard",
    meshPrimitive: "cube",
    count: 100_000,
    seed: 13_337,
    lifetime: 6,
    emitterShape: "sphere",
    emitterPosition: [0, 0, 0],
    emitterSize: [0.24, 0.24, 0.24],
    emitterSpread: 70,
    velocity: [0.16, 0.08, 0],
    gravity: [0, -0.035, 0],
    drag: 0.02,
    turbulence: 0.025,
    turbulenceScale: 2.5,
    startColor: [0.5, 0.74, 1],
    endColor: [0.875, 0.935, 1],
    startOpacity: 0.65,
    endOpacity: 0,
    startSize: 2.4,
    endSize: 0.35,
    startRotation: 0,
    endRotation: 180,
    streakLength: 0.65,
  };
}

export function normalizeParticleSettings(settings: ParticleSettings): ParticleSettings {
  const fallback = createDefaultParticleSettings();
  return {
    renderMode: includes(["billboard", "streak", "mesh"], settings.renderMode)
      ? settings.renderMode
      : fallback.renderMode,
    meshPrimitive: settings.meshPrimitive === "cube" ? "cube" : fallback.meshPrimitive,
    count: Math.round(bound(settings.count, PARTICLE_LIMITS.count, fallback.count)),
    seed: Math.round(bound(settings.seed, PARTICLE_LIMITS.seed, fallback.seed)),
    lifetime: bound(settings.lifetime, PARTICLE_LIMITS.lifetime, fallback.lifetime),
    emitterShape: includes(["point", "box", "sphere", "ring", "line"], settings.emitterShape)
      ? settings.emitterShape
      : fallback.emitterShape,
    emitterPosition: boundVector(
      settings.emitterPosition,
      PARTICLE_LIMITS.emitterPosition,
      fallback.emitterPosition,
    ),
    emitterSize: boundVector(
      settings.emitterSize,
      PARTICLE_LIMITS.emitterSize,
      fallback.emitterSize,
    ),
    emitterSpread: bound(
      settings.emitterSpread,
      PARTICLE_LIMITS.emitterSpread,
      fallback.emitterSpread,
    ),
    velocity: boundVector(settings.velocity, PARTICLE_LIMITS.velocity, fallback.velocity),
    gravity: boundVector(settings.gravity, PARTICLE_LIMITS.gravity, fallback.gravity),
    drag: bound(settings.drag, PARTICLE_LIMITS.drag, fallback.drag),
    turbulence: bound(settings.turbulence, PARTICLE_LIMITS.turbulence, fallback.turbulence),
    turbulenceScale: bound(
      settings.turbulenceScale,
      PARTICLE_LIMITS.turbulenceScale,
      fallback.turbulenceScale,
    ),
    startColor: boundVector(settings.startColor, PARTICLE_LIMITS.color, fallback.startColor),
    endColor: boundVector(settings.endColor, PARTICLE_LIMITS.color, fallback.endColor),
    startOpacity: bound(settings.startOpacity, PARTICLE_LIMITS.opacity, fallback.startOpacity),
    endOpacity: bound(settings.endOpacity, PARTICLE_LIMITS.opacity, fallback.endOpacity),
    startSize: bound(settings.startSize, PARTICLE_LIMITS.size, fallback.startSize),
    endSize: bound(settings.endSize, PARTICLE_LIMITS.size, fallback.endSize),
    startRotation: bound(settings.startRotation, PARTICLE_LIMITS.rotation, fallback.startRotation),
    endRotation: bound(settings.endRotation, PARTICLE_LIMITS.rotation, fallback.endRotation),
    streakLength: bound(settings.streakLength, PARTICLE_LIMITS.streakLength, fallback.streakLength),
  };
}

export function assertParticleSettings(
  value: unknown,
  path = "particle",
): asserts value is ParticleSettings {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`${path} must be an object`);
  const particle = value as Record<string, unknown>;
  const expected = new Set<string>(PARTICLE_SETTING_KEYS);
  for (const key of Object.keys(particle))
    if (!expected.has(key)) throw new Error(`${path}.${key} is not supported`);
  for (const key of PARTICLE_SETTING_KEYS)
    if (!(key in particle)) throw new Error(`${path}.${key} is required`);
  if (!includes(["billboard", "streak", "mesh"], particle.renderMode))
    throw new Error(`${path}.renderMode must be billboard, streak, or mesh`);
  if (particle.meshPrimitive !== "cube") throw new Error(`${path}.meshPrimitive must be cube`);
  if (!includes(["point", "box", "sphere", "ring", "line"], particle.emitterShape))
    throw new Error(`${path}.emitterShape must be point, box, sphere, ring, or line`);
  assertBoundedNumber(particle.count, PARTICLE_LIMITS.count, `${path}.count`, true);
  assertBoundedNumber(particle.seed, PARTICLE_LIMITS.seed, `${path}.seed`, true);
  assertBoundedNumber(particle.lifetime, PARTICLE_LIMITS.lifetime, `${path}.lifetime`);
  assertBoundedVector(
    particle.emitterPosition,
    PARTICLE_LIMITS.emitterPosition,
    `${path}.emitterPosition`,
  );
  assertBoundedVector(particle.emitterSize, PARTICLE_LIMITS.emitterSize, `${path}.emitterSize`);
  assertBoundedNumber(
    particle.emitterSpread,
    PARTICLE_LIMITS.emitterSpread,
    `${path}.emitterSpread`,
  );
  assertBoundedVector(particle.velocity, PARTICLE_LIMITS.velocity, `${path}.velocity`);
  assertBoundedVector(particle.gravity, PARTICLE_LIMITS.gravity, `${path}.gravity`);
  assertBoundedNumber(particle.drag, PARTICLE_LIMITS.drag, `${path}.drag`);
  assertBoundedNumber(particle.turbulence, PARTICLE_LIMITS.turbulence, `${path}.turbulence`);
  assertBoundedNumber(
    particle.turbulenceScale,
    PARTICLE_LIMITS.turbulenceScale,
    `${path}.turbulenceScale`,
  );
  assertBoundedVector(particle.startColor, PARTICLE_LIMITS.color, `${path}.startColor`);
  assertBoundedVector(particle.endColor, PARTICLE_LIMITS.color, `${path}.endColor`);
  assertBoundedNumber(particle.startOpacity, PARTICLE_LIMITS.opacity, `${path}.startOpacity`);
  assertBoundedNumber(particle.endOpacity, PARTICLE_LIMITS.opacity, `${path}.endOpacity`);
  assertBoundedNumber(particle.startSize, PARTICLE_LIMITS.size, `${path}.startSize`);
  assertBoundedNumber(particle.endSize, PARTICLE_LIMITS.size, `${path}.endSize`);
  assertBoundedNumber(particle.startRotation, PARTICLE_LIMITS.rotation, `${path}.startRotation`);
  assertBoundedNumber(particle.endRotation, PARTICLE_LIMITS.rotation, `${path}.endRotation`);
  assertBoundedNumber(particle.streakLength, PARTICLE_LIMITS.streakLength, `${path}.streakLength`);
}

function includes<const Value extends string>(
  options: readonly Value[],
  value: unknown,
): value is Value {
  return typeof value === "string" && (options as readonly string[]).includes(value);
}

function bound(
  value: number,
  [minimum, maximum]: readonly [number, number],
  fallback: number,
): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(minimum, Math.min(maximum, value));
}

function boundVector(
  value: unknown,
  range: readonly [number, number],
  fallback: readonly [number, number, number],
): [number, number, number] {
  if (!Array.isArray(value) || value.length !== 3) return [...fallback];
  return [
    bound(Number(value[0]), range, fallback[0]),
    bound(Number(value[1]), range, fallback[1]),
    bound(Number(value[2]), range, fallback[2]),
  ];
}

function assertBoundedNumber(
  value: unknown,
  [minimum, maximum]: readonly [number, number],
  path: string,
  integer = false,
): asserts value is number {
  if (typeof value !== "number" || !Number.isFinite(value))
    throw new Error(`${path} must be a finite number`);
  if (integer && !Number.isInteger(value)) throw new Error(`${path} must be an integer`);
  if (value < minimum || value > maximum)
    throw new Error(`${path} must be between ${minimum} and ${maximum}`);
}

function assertBoundedVector(
  value: unknown,
  range: readonly [number, number],
  path: string,
): asserts value is [number, number, number] {
  if (!Array.isArray(value) || value.length !== 3)
    throw new Error(`${path} must contain exactly three channels`);
  for (let index = 0; index < value.length; index += 1)
    assertBoundedNumber(value[index], range, `${path}[${index}]`);
}
