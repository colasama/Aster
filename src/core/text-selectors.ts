import { evaluateAnimatable } from "./timeline";
import type { Animatable } from "./types";

export type TextSelectorMode = "add" | "subtract" | "intersect" | "min" | "max" | "difference";
export type TextSelectorBasedOn = "characters" | "charactersExcludingSpaces" | "words" | "lines";
export type TextRangeUnits = "percentage" | "index";
export type TextRangeShape = "square" | "rampUp" | "rampDown" | "triangle" | "round" | "smooth";

export interface TextUnitContext {
  characterIndex: number;
  characterCount: number;
  characterExcludingSpacesIndex?: number;
  characterExcludingSpacesCount: number;
  wordIndex: number;
  wordCount: number;
  lineIndex: number;
  lineCount: number;
  isWhitespace: boolean;
}

interface CommonTextSelector {
  id: string;
  name: string;
  enabled: boolean;
  mode: TextSelectorMode;
  amount: Animatable;
  basedOn: TextSelectorBasedOn;
}

export interface TextRangeSelector extends CommonTextSelector {
  kind: "range";
  units: TextRangeUnits;
  start: Animatable;
  end: Animatable;
  offset: Animatable;
  shape: TextRangeShape;
  smoothness: Animatable;
  easeHigh: Animatable;
  easeLow: Animatable;
  randomizeOrder: boolean;
  randomSeed: number;
}

export interface TextWigglySelector extends CommonTextSelector {
  kind: "wiggly";
  minimumAmount: Animatable;
  maximumAmount: Animatable;
  wigglesPerSecond: Animatable;
  correlation: Animatable;
  temporalPhase: Animatable;
  spatialPhase: Animatable;
  randomSeed: number;
}

export interface TextExpressionSelector extends CommonTextSelector {
  kind: "expression";
  expression: string;
}

export type TextSelector = TextRangeSelector | TextWigglySelector | TextExpressionSelector;

export interface TextExpressionSelectorContext {
  textIndex: number;
  textTotal: number;
  selectorValue: number;
  time: number;
}

export type TextExpressionSelectorEvaluator = (
  expression: string,
  context: TextExpressionSelectorContext,
) => number;

export interface TextSelectorEvaluationOptions {
  time: number;
  animatorSeed?: number;
  evaluateExpression?: TextExpressionSelectorEvaluator;
  /** Value produced by selectors above this one, in the -100 through 100 scale. */
  selectorValue?: number;
}

interface EvaluatedSelectorTracks {
  time: number;
  amount: number;
  start?: number;
  end?: number;
  offset?: number;
  smoothness?: number;
  easeHigh?: number;
  easeLow?: number;
  minimumAmount?: number;
  maximumAmount?: number;
  wigglesPerSecond?: number;
  correlation?: number;
  temporalPhase?: number;
  spatialPhase?: number;
}

const evaluatedSelectorCache = new WeakMap<TextSelector, EvaluatedSelectorTracks>();

export function evaluateTextSelectors(
  selectors: readonly TextSelector[],
  unit: TextUnitContext,
  options: TextSelectorEvaluationOptions,
): number {
  let combined = 0;
  let evaluated = false;
  for (const selector of selectors) {
    if (!selector.enabled) continue;
    if (!evaluated) combined = initialSelectorValue(selector.mode);
    const value = evaluateTextSelector(selector, unit, {
      ...options,
      selectorValue: evaluated ? combined * 100 : 100,
    });
    combined = combineSelectorValue(combined, value, selector.mode);
    evaluated = true;
  }
  return clamp(combined, -1, 1);
}

export function evaluateTextSelector(
  selector: TextSelector,
  unit: TextUnitContext,
  options: TextSelectorEvaluationOptions,
): number {
  const domain = selectorDomain(unit, selector.basedOn);
  if (!domain || domain.count < 1) return 0;
  const tracks = evaluatedSelectorTracks(selector, options.time);
  const selectorAmount = bounded(tracks.amount, -100, 100, 100) / 100;
  if (selector.kind === "range")
    return (
      evaluateRangeSelector(selector, tracks, domain.index, domain.count, options) * selectorAmount
    );
  if (selector.kind === "wiggly")
    return (
      evaluateWigglySelector(selector, tracks, domain.index, domain.count, options) * selectorAmount
    );
  const selectorValue = bounded(options.selectorValue, -100, 100, 100);
  const evaluated = options.evaluateExpression?.(selector.expression, {
    textIndex: domain.index + 1,
    textTotal: domain.count,
    selectorValue,
    time: options.time,
  });
  return (bounded(evaluated, -100, 100, selectorValue) / 100) * selectorAmount;
}

function initialSelectorValue(mode: TextSelectorMode): number {
  return mode === "subtract" || mode === "intersect" || mode === "min" ? 1 : 0;
}

export function combineSelectorValue(
  previous: number,
  current: number,
  mode: TextSelectorMode,
): number {
  switch (mode) {
    case "add":
      return clamp(previous + current, -1, 1);
    case "subtract":
      return clamp(previous - current, -1, 1);
    case "intersect":
      return previous * current;
    case "min":
      return Math.min(previous, current);
    case "max":
      return Math.max(previous, current);
    case "difference":
      return Math.abs(previous - current);
  }
}

function evaluateRangeSelector(
  selector: TextRangeSelector,
  tracks: EvaluatedSelectorTracks,
  sourceIndex: number,
  count: number,
  options: TextSelectorEvaluationOptions,
): number {
  const index = selector.randomizeOrder
    ? randomizedIndex(sourceIndex, count, selector.randomSeed || options.animatorSeed || 0)
    : sourceIndex;
  const position = selector.units === "percentage" ? ((index + 0.5) / count) * 100 : index + 0.5;
  const domainSize = selector.units === "percentage" ? 100 : count;
  const offset = tracks.offset ?? 0;
  const start = (tracks.start ?? 0) + offset;
  const end = (tracks.end ?? 100) + offset;
  const reversed = start > end;
  const low = Math.min(start, end);
  const high = Math.max(start, end);
  const span = Math.max(high - low, Number.EPSILON);
  const wrapped = wrapNearRange(position, low, high, domainSize);
  const progress = clamp((wrapped - low) / span, 0, 1);
  let value: number;
  switch (selector.shape) {
    case "square":
      value = squareSelection(wrapped, low, high, tracks.smoothness ?? 100, domainSize);
      break;
    case "rampUp":
      value = progress;
      break;
    case "rampDown":
      value = 1 - progress;
      break;
    case "triangle":
      value = 1 - Math.abs(progress * 2 - 1);
      break;
    case "round": {
      const centered = progress * 2 - 1;
      value = Math.sqrt(Math.max(0, 1 - centered * centered));
      break;
    }
    case "smooth":
      value = smoothStep(progress) * smoothStep(1 - progress) * 4;
      break;
  }
  if (wrapped < low || wrapped > high) value = 0;
  if (reversed) value = 1 - value;
  return applySelectorEase(clamp(value, 0, 1), tracks.easeLow ?? 0, tracks.easeHigh ?? 0);
}

function evaluateWigglySelector(
  selector: TextWigglySelector,
  tracks: EvaluatedSelectorTracks,
  index: number,
  count: number,
  options: TextSelectorEvaluationOptions,
): number {
  const rate = bounded(tracks.wigglesPerSecond, 0, 100, 2);
  const temporal = options.time * rate + (tracks.temporalPhase ?? 0);
  const lower = Math.floor(temporal);
  const mix = smoothStep(temporal - lower);
  const seed = selector.randomSeed || options.animatorSeed || hashString(selector.id);
  const common = interpolateNoise(seed, lower, mix, 0);
  const spatialCoordinate = (index / Math.max(1, count)) * (tracks.spatialPhase ?? 1);
  const individual = interpolateNoise(seed, lower, mix, index + spatialCoordinate);
  const correlation = bounded(tracks.correlation, 0, 100, 0) / 100;
  const noise = individual * (1 - correlation) + common * correlation;
  const minimum = bounded(tracks.minimumAmount, -100, 100, -100) / 100;
  const maximum = bounded(tracks.maximumAmount, -100, 100, 100) / 100;
  return minimum + (maximum - minimum) * noise;
}

function evaluatedSelectorTracks(selector: TextSelector, rawTime: number): EvaluatedSelectorTracks {
  const time = Number.isFinite(rawTime) ? rawTime : 0;
  const cached = evaluatedSelectorCache.get(selector);
  if (cached && Object.is(cached.time, time)) return cached;
  const common = { time, amount: evaluateAnimatable(selector.amount, time) };
  const evaluated: EvaluatedSelectorTracks =
    selector.kind === "range"
      ? {
          ...common,
          start: evaluateAnimatable(selector.start, time),
          end: evaluateAnimatable(selector.end, time),
          offset: evaluateAnimatable(selector.offset, time),
          smoothness: evaluateAnimatable(selector.smoothness, time),
          easeHigh: evaluateAnimatable(selector.easeHigh, time),
          easeLow: evaluateAnimatable(selector.easeLow, time),
        }
      : selector.kind === "wiggly"
        ? {
            ...common,
            minimumAmount: evaluateAnimatable(selector.minimumAmount, time),
            maximumAmount: evaluateAnimatable(selector.maximumAmount, time),
            wigglesPerSecond: evaluateAnimatable(selector.wigglesPerSecond, time),
            correlation: evaluateAnimatable(selector.correlation, time),
            temporalPhase: evaluateAnimatable(selector.temporalPhase, time),
            spatialPhase: evaluateAnimatable(selector.spatialPhase, time),
          }
        : common;
  evaluatedSelectorCache.set(selector, evaluated);
  return evaluated;
}

function selectorDomain(
  unit: TextUnitContext,
  basedOn: TextSelectorBasedOn,
): { index: number; count: number } | undefined {
  switch (basedOn) {
    case "characters":
      return { index: unit.characterIndex, count: unit.characterCount };
    case "charactersExcludingSpaces":
      return unit.isWhitespace || unit.characterExcludingSpacesIndex === undefined
        ? undefined
        : {
            index: unit.characterExcludingSpacesIndex,
            count: unit.characterExcludingSpacesCount,
          };
    case "words":
      return { index: unit.wordIndex, count: unit.wordCount };
    case "lines":
      return { index: unit.lineIndex, count: unit.lineCount };
  }
}

function squareSelection(
  position: number,
  low: number,
  high: number,
  smoothness: number,
  domainSize: number,
): number {
  if (position < low || position > high) return 0;
  const feather = ((100 - bounded(smoothness, 0, 100, 100)) / 100) * domainSize * 0.5;
  if (feather <= Number.EPSILON) return 1;
  return Math.min(smoothStep((position - low) / feather), smoothStep((high - position) / feather));
}

function applySelectorEase(value: number, easeLow: number, easeHigh: number): number {
  if (value <= 0 || value >= 1) return value;
  const lowPower = 2 ** (-bounded(easeLow, -100, 100, 0) / 100);
  const highPower = 2 ** (-bounded(easeHigh, -100, 100, 0) / 100);
  const low = value ** lowPower;
  const high = 1 - (1 - value) ** highPower;
  return clamp(low * (1 - value) + high * value, 0, 1);
}

function randomizedIndex(index: number, count: number, seed: number): number {
  if (count <= 1) return 0;
  let state = nextRandom((Math.trunc(seed) || 0x6d2b79f5) >>> 0);
  let multiplier = (state % count) | 1;
  while (greatestCommonDivisor(multiplier, count) !== 1) multiplier = (multiplier + 2) % count || 1;
  state = nextRandom(state);
  return (Math.imul(multiplier, index) + (state % count)) % count;
}

function greatestCommonDivisor(left: number, right: number): number {
  let a = Math.abs(left);
  let b = Math.abs(right);
  while (b > 0) [a, b] = [b, a % b];
  return a;
}

function interpolateNoise(seed: number, time: number, mix: number, spatial: number): number {
  const first = noise(seed, time, spatial);
  const second = noise(seed, time + 1, spatial);
  return first + (second - first) * mix;
}

function noise(seed: number, time: number, spatial: number): number {
  let state = (Math.trunc(seed) ^ Math.imul(Math.trunc(time), 0x9e3779b1)) >>> 0;
  state ^= Math.imul(Math.trunc(spatial * 65_536), 0x85ebca6b);
  return nextRandom(state) / 0xffff_ffff;
}

function nextRandom(value: number): number {
  let state = (value + 0x6d2b79f5) >>> 0;
  state = Math.imul(state ^ (state >>> 15), state | 1);
  state ^= state + Math.imul(state ^ (state >>> 7), state | 61);
  return (state ^ (state >>> 14)) >>> 0;
}

function wrapNearRange(position: number, low: number, high: number, domainSize: number): number {
  if (domainSize <= 0) return position;
  const center = (low + high) * 0.5;
  return position + Math.round((center - position) / domainSize) * domainSize;
}

function smoothStep(value: number): number {
  const boundedValue = clamp(value, 0, 1);
  return boundedValue * boundedValue * (3 - 2 * boundedValue);
}

function bounded(
  value: number | undefined,
  minimum: number,
  maximum: number,
  fallback: number,
): number {
  const finite = typeof value === "number" && Number.isFinite(value) ? value : fallback;
  return clamp(finite, minimum, maximum);
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function hashString(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}
