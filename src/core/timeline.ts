import type { Animatable, Effect, EvaluatedTransform, Keyframe, Transform } from "./types";

export function evaluateAnimatable(property: Animatable, time: number): number {
  if (property.mode === "static") return property.value;
  const { keyframes } = property;
  if (keyframes.length === 0) return 0;
  let low = 0;
  let high = keyframes.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (keyframes[middle].time <= time) low = middle + 1;
    else high = middle;
  }
  if (low === 0) return keyframes[0].value;
  if (low === keyframes.length) return keyframes[keyframes.length - 1].value;
  const previous = keyframes[low - 1];
  const next = keyframes[low];
  const span = next.time - previous.time;
  if (span <= Number.EPSILON) return next.value;
  const progress = Math.max(0, Math.min(1, (time - previous.time) / span));
  const eased = interpolateProgress(previous, progress);
  return previous.value + (next.value - previous.value) * eased;
}

export function evaluateTransform(transform: Transform, time: number): EvaluatedTransform {
  const evaluateVector = (properties: [Animatable, Animatable, Animatable]) =>
    properties.map((property) => evaluateAnimatable(property, time)) as [number, number, number];
  return {
    position: evaluateVector(transform.position),
    rotation: evaluateVector(transform.rotation),
    scale: evaluateVector(transform.scale),
    anchor: evaluateVector(transform.anchor),
    opacity: Math.max(0, Math.min(100, evaluateAnimatable(transform.opacity, time))) / 100,
  };
}

export function evaluateEffectParameter(
  effect: Effect,
  parameter: string,
  time: number,
  fallback = 0,
): number {
  const keyframes = effect.parameterKeyframes?.[parameter];
  if (keyframes?.length) return evaluateAnimatable({ mode: "animated", keyframes }, time);
  return effect.parameters[parameter] ?? fallback;
}

export function insertKeyframe(property: Animatable, keyframe: Keyframe): Animatable {
  const keyframes =
    property.mode === "animated"
      ? property.keyframes.filter((entry) => Math.abs(entry.time - keyframe.time) > 0.000_001)
      : [];
  keyframes.push(keyframe);
  keyframes.sort((left, right) => left.time - right.time);
  return { mode: "animated", keyframes };
}

export function frameAt(
  time: number,
  frameRate: { numerator: number; denominator: number },
): number {
  return Math.round((time * frameRate.numerator) / frameRate.denominator);
}

export function timeAtFrame(
  frame: number,
  frameRate: { numerator: number; denominator: number },
): number {
  return (frame * frameRate.denominator) / frameRate.numerator;
}

function interpolateProgress(keyframe: Keyframe, progress: number): number {
  if (keyframe.interpolation === "step") return 0;
  if (keyframe.interpolation === "linear") return progress;
  const [x1, y1, x2, y2] = keyframe.easing ?? [0.42, 0, 0.58, 1];
  let parameter = progress;
  for (let iteration = 0; iteration < 6; iteration += 1) {
    const error = cubic(parameter, x1, x2) - progress;
    const slope = cubicDerivative(parameter, x1, x2);
    if (Math.abs(slope) < 1e-7) break;
    parameter = Math.max(0, Math.min(1, parameter - error / slope));
  }
  return cubic(parameter, y1, y2);
}

function cubic(time: number, control1: number, control2: number): number {
  const inverse = 1 - time;
  return (
    3 * inverse * inverse * time * control1 +
    3 * inverse * time * time * control2 +
    time * time * time
  );
}

function cubicDerivative(time: number, control1: number, control2: number): number {
  return (
    3 * (1 - time) ** 2 * control1 +
    6 * (1 - time) * time * (control2 - control1) +
    3 * time ** 2 * (1 - control2)
  );
}
