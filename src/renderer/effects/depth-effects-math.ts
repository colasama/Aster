import type { DepthEffectSettings } from "./depth-effects";

export interface LayeredDepthOfFieldPlan {
  frontRadius: number;
  peeledRadius: number;
  fallbackRadius: number;
  frontWeight: number;
  peeledWeight: number;
  fallbackWeight: number;
}

export interface LayeredDepthOfFieldColors {
  front: readonly [number, number, number, number];
  peeled: readonly [number, number, number, number];
  residual: readonly [number, number, number, number];
}

export function resolveLayeredDepthOfFieldColors(
  scene: readonly [number, number, number, number],
  rawFront: readonly [number, number, number, number],
  rawPeeled: readonly [number, number, number, number],
): LayeredDepthOfFieldColors {
  const front = rawFront[3] >= 0.999 ? scene : rawFront;
  const afterFront = 1 - bounded(front[3], 0, 1);
  const peeled =
    rawPeeled[3] >= 0.999 && afterFront > 0.00001
      ? (rgbaSubtractAndScale(scene, front, 1).map((value) => value / afterFront) as [
          number,
          number,
          number,
          number,
        ])
      : rawPeeled;
  const transmittance = afterFront * (1 - bounded(peeled[3], 0, 1));
  const remainder = rgbaSubtractAndScale(scene, front, 1);
  const residualNumerator = rgbaSubtractAndScale(remainder, peeled, afterFront);
  return {
    front,
    peeled,
    residual:
      transmittance > 0.00001
        ? (residualNumerator.map((value) => Math.max(0, value / transmittance)) as [
            number,
            number,
            number,
            number,
          ])
        : [0, 0, 0, 0],
  };
}

export function planLayeredDepthOfField(
  frontCoc: number,
  frontCoverage: number,
  peeledCoc: number,
  peeledCoverage: number,
  fallbackCoc: number,
): LayeredDepthOfFieldPlan {
  const frontWeight = bounded(frontCoverage, 0, 1);
  const peeledWeight = (1 - frontWeight) * bounded(peeledCoverage, 0, 1);
  return {
    frontRadius: Math.abs(finite(frontCoc, 0)),
    peeledRadius: Math.abs(finite(peeledCoc, 0)),
    fallbackRadius: Math.abs(finite(fallbackCoc, 0)),
    frontWeight,
    peeledWeight,
    fallbackWeight: 1 - frontWeight - peeledWeight,
  };
}

export function depthOfFieldDiffractionWeights(
  sampleCount: number,
  diffractionFringe: number,
): readonly number[] {
  const count = Math.round(bounded(sampleCount, 1, 64));
  const fringe = bounded(diffractionFringe, 0, 100) / 100;
  const weights = Array.from({ length: count }, (_, index) => {
    const radius = Math.sqrt((index + 0.5) / count);
    const boundaryProfile = 5 * radius ** 8;
    return 1 - fringe + fringe * boundaryProfile;
  });
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  return weights.map((weight) => weight / total);
}

export function depthEffectCircleOfConfusion(
  settings: Pick<
    DepthEffectSettings,
    | "focusDistance"
    | "focusAreaWidth"
    | "aperture"
    | "zoom"
    | "blurLevel"
    | "nearBlurLevel"
    | "farBlurLevel"
    | "maximumBlurRadius"
  >,
  surfaceDepth: number,
): number {
  const depth = Math.max(finite(surfaceDepth, 0), 0.0001);
  const focusError = depth - settings.focusDistance;
  const defocused = Math.max(Math.abs(focusError) - Math.max(settings.focusAreaWidth, 0) * 0.5, 0);
  const sideLevel = focusError < 0 ? settings.nearBlurLevel : settings.farBlurLevel;
  const radius = Math.min(
    settings.aperture *
      0.5 *
      (settings.zoom / Math.max(settings.focusDistance, 0.001)) *
      (defocused / depth) *
      (settings.blurLevel / 100) *
      (sideLevel / 100),
    settings.maximumBlurRadius,
  );
  return focusError < 0 ? -radius : radius;
}

export function applyDepthOfFieldHighlight(
  color: readonly [number, number, number],
  gain: number,
  threshold: number,
  saturation: number,
): readonly [number, number, number] {
  const luminance = color[0] * 0.2126 + color[1] * 0.7152 + color[2] * 0.0722;
  const highlightAmount = smoothstep(threshold, threshold + 0.25, luminance);
  const saturated = color.map(
    (channel) => luminance + ((channel - luminance) * bounded(saturation, 0, 100)) / 100,
  ) as [number, number, number];
  const highlightColor = color.map(
    (channel, index) => channel + (saturated[index] - channel) * highlightAmount,
  ) as [number, number, number];
  const highlightGain = 1 + Math.max(luminance - threshold, 0) * (bounded(gain, 0, 100) / 100) * 8;
  return highlightColor.map((channel) => channel * highlightGain) as [number, number, number];
}

function finite(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}

function bounded(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, finite(value, minimum)));
}

function smoothstep(edge0: number, edge1: number, value: number): number {
  const amount = bounded((value - edge0) / Math.max(edge1 - edge0, 0.00001), 0, 1);
  return amount * amount * (3 - 2 * amount);
}

function rgbaSubtractAndScale(
  left: readonly [number, number, number, number],
  right: readonly [number, number, number, number],
  rightScale: number,
): [number, number, number, number] {
  return left.map((value, index) => Math.max(0, value - right[index] * rightScale)) as [
    number,
    number,
    number,
    number,
  ];
}
