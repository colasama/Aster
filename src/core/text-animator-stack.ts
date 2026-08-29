import {
  evaluateTextSelectors,
  type TextExpressionSelectorEvaluator,
  type TextSelector,
  type TextUnitContext,
} from "./text-selectors";
import { evaluateAnimatable } from "./timeline";
import type { Animatable } from "./types";

export const MAX_TEXT_ANIMATOR_GROUPS = 32;
export const MAX_TEXT_LAYOUT_UNITS = 4096;
const MAX_TEXT_LAYOUT_CACHE_ENTRIES = 64;
const MAX_TEXT_LAYOUT_CACHE_UNITS = 32_768;
const textLayoutCache = new Map<string, readonly TextLayoutUnit[]>();
let cachedTextLayoutUnits = 0;

export type TextAnimatorColor = [number, number, number, number];
export type TextCharacterRange = "preserveCaseAndDigits" | "fullUnicode";
export type TextAnimatorVector2Property = [Animatable, Animatable];
export type TextAnimatorVector3Property = [Animatable, Animatable, Animatable];
export type TextAnimatorColorProperty = [Animatable, Animatable, Animatable, Animatable];

export interface TextAnimatorProperties {
  anchorPoint?: TextAnimatorVector3Property;
  position?: TextAnimatorVector3Property;
  scale?: TextAnimatorVector3Property;
  rotation?: TextAnimatorVector3Property;
  skew?: Animatable;
  skewAxis?: Animatable;
  opacity?: Animatable;
  fillColor?: TextAnimatorColorProperty;
  strokeColor?: TextAnimatorColorProperty;
  strokeWidth?: Animatable;
  tracking?: Animatable;
  lineAnchor?: Animatable;
  lineSpacing?: TextAnimatorVector2Property;
  characterOffset?: Animatable;
  characterValue?: Animatable;
  characterRange?: TextCharacterRange;
  blur?: TextAnimatorVector2Property;
}

interface EvaluatedTextAnimatorProperties {
  time: number;
  anchorPoint?: [number, number, number];
  position?: [number, number, number];
  scale?: [number, number, number];
  rotation?: [number, number, number];
  skew?: number;
  skewAxis?: number;
  opacity?: number;
  fillColor?: TextAnimatorColor;
  strokeColor?: TextAnimatorColor;
  strokeWidth?: number;
  tracking?: number;
  lineAnchor?: number;
  lineSpacing?: [number, number];
  characterOffset?: number;
  characterValue?: number;
  characterRange?: TextCharacterRange;
  blur?: [number, number];
}

const evaluatedPropertiesCache = new WeakMap<
  TextAnimatorProperties,
  EvaluatedTextAnimatorProperties
>();

export interface TextAnimatorGroup {
  id: string;
  name: string;
  enabled: boolean;
  randomSeed: number;
  selectors: TextSelector[];
  properties: TextAnimatorProperties;
}

export interface TextAnimatorStackSettings {
  enabled: boolean;
  groups: TextAnimatorGroup[];
}

export interface TextAnimatorBaseStyle {
  fillColor?: TextAnimatorColor;
  strokeColor?: TextAnimatorColor;
  strokeWidth?: number;
  opacity?: number;
  codePoint?: number;
}

export interface EvaluatedTextAnimatorCharacter {
  anchorPoint: [number, number, number];
  position: [number, number, number];
  scale: [number, number, number];
  rotation: [number, number, number];
  skew: number;
  skewAxis: number;
  opacity: number;
  fillColor?: TextAnimatorColor;
  strokeColor?: TextAnimatorColor;
  strokeWidth: number;
  tracking: number;
  lineAnchor: number;
  lineSpacing: [number, number];
  codePoint: number;
  blur: [number, number];
}

export interface TextAnimatorStackEvaluationOptions {
  time: number;
  evaluateExpression?: TextExpressionSelectorEvaluator;
  baseStyle?: TextAnimatorBaseStyle;
}

export interface TextLayoutUnit extends TextUnitContext {
  text: string;
  sourceStart: number;
  sourceEnd: number;
  codePoint: number;
}

/** Evaluates ordered AE-style animator groups without relying on previous-frame state. */
export function evaluateTextAnimatorStack(
  animators: readonly TextAnimatorGroup[],
  unit: TextUnitContext,
  options: TextAnimatorStackEvaluationOptions,
): EvaluatedTextAnimatorCharacter {
  const base = options.baseStyle;
  const result: EvaluatedTextAnimatorCharacter = {
    anchorPoint: [0, 0, 0],
    position: [0, 0, 0],
    scale: [1, 1, 1],
    rotation: [0, 0, 0],
    skew: 0,
    skewAxis: 0,
    opacity: bounded(base?.opacity, 0, 1, 1),
    ...(base?.fillColor ? { fillColor: normalizeColor(base.fillColor) } : {}),
    ...(base?.strokeColor ? { strokeColor: normalizeColor(base.strokeColor) } : {}),
    strokeWidth: finite(base?.strokeWidth),
    tracking: 0,
    lineAnchor: 50,
    lineSpacing: [0, 0],
    codePoint: normalizeCodePoint(base?.codePoint),
    blur: [0, 0],
  };
  const animatorCount = Math.min(animators.length, MAX_TEXT_ANIMATOR_GROUPS);
  for (let animatorIndex = 0; animatorIndex < animatorCount; animatorIndex += 1) {
    const animator = animators[animatorIndex];
    if (!animator) continue;
    if (!animator.enabled) continue;
    const amount = animator.selectors.length
      ? evaluateTextSelectors(animator.selectors, unit, {
          time: finite(options.time),
          animatorSeed: animator.randomSeed,
          evaluateExpression: options.evaluateExpression,
        })
      : 1;
    applyAnimatorProperties(result, evaluatedProperties(animator.properties, options.time), amount);
  }
  result.opacity = clamp(result.opacity, 0, 1);
  result.strokeWidth = Math.max(0, result.strokeWidth);
  result.blur[0] = Math.max(0, result.blur[0]);
  result.blur[1] = Math.max(0, result.blur[1]);
  result.codePoint = normalizeCodePoint(result.codePoint);
  return result;
}

/** Builds bounded grapheme units and every selector domain in one linear pass. */
export function segmentTextLayoutUnits(text: string): readonly TextLayoutUnit[] {
  const cached = textLayoutCache.get(text);
  if (cached) {
    textLayoutCache.delete(text);
    textLayoutCache.set(text, cached);
    return cached;
  }
  const graphemes = [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text)]
    .filter((segment) => !isLineBreak(segment.segment))
    .slice(0, MAX_TEXT_LAYOUT_UNITS);
  const wordSpans = [
    ...new Intl.Segmenter(undefined, { granularity: "word" }).segment(text),
  ].flatMap((segment) =>
    segment.isWordLike
      ? [{ start: segment.index, end: segment.index + segment.segment.length }]
      : [],
  );
  const lineStarts = collectLineStarts(text);
  const characterExcludingSpacesCount = graphemes.reduce(
    (count, segment) => count + (isWhitespace(segment.segment) ? 0 : 1),
    0,
  );
  let characterExcludingSpacesIndex = 0;
  let wordCursor = 0;
  const units = graphemes.map((segment, characterIndex) => {
    while ((wordSpans[wordCursor]?.end ?? Number.POSITIVE_INFINITY) <= segment.index)
      wordCursor += 1;
    const isSpace = isWhitespace(segment.segment);
    const excludingIndex = isSpace ? undefined : characterExcludingSpacesIndex++;
    const containingWord = wordSpans[wordCursor];
    const wordIndex =
      containingWord && segment.index >= containingWord.start && segment.index < containingWord.end
        ? wordCursor
        : clamp(wordCursor - 1, 0, Math.max(0, wordSpans.length - 1));
    return {
      text: segment.segment,
      sourceStart: segment.index,
      sourceEnd: segment.index + segment.segment.length,
      codePoint: segment.segment.codePointAt(0) ?? 0xfffd,
      characterIndex,
      characterCount: graphemes.length,
      ...(excludingIndex === undefined ? {} : { characterExcludingSpacesIndex: excludingIndex }),
      characterExcludingSpacesCount,
      wordIndex,
      wordCount: wordSpans.length,
      lineIndex: findLineIndex(lineStarts, segment.index),
      lineCount: lineStarts.length,
      isWhitespace: isSpace,
    };
  });
  textLayoutCache.set(text, units);
  cachedTextLayoutUnits += units.length;
  while (
    textLayoutCache.size > MAX_TEXT_LAYOUT_CACHE_ENTRIES ||
    cachedTextLayoutUnits > MAX_TEXT_LAYOUT_CACHE_UNITS
  ) {
    const oldest = textLayoutCache.entries().next().value as
      | [string, readonly TextLayoutUnit[]]
      | undefined;
    if (!oldest) break;
    textLayoutCache.delete(oldest[0]);
    cachedTextLayoutUnits -= oldest[1].length;
  }
  return units;
}

function applyAnimatorProperties(
  result: EvaluatedTextAnimatorCharacter,
  properties: EvaluatedTextAnimatorProperties,
  rawAmount: number,
): void {
  const amount = bounded(rawAmount, -1, 1, 0);
  addVector3(result.anchorPoint, properties.anchorPoint, amount);
  addVector3(result.position, properties.position, amount);
  addVector3(result.rotation, properties.rotation, amount);
  multiplyScale(result.scale, properties.scale, amount);
  result.skew += finite(properties.skew) * amount;
  result.skewAxis += finite(properties.skewAxis) * amount;
  result.opacity *= 1 + (bounded(properties.opacity, 0, 100, 100) / 100 - 1) * amount;
  result.strokeWidth += finite(properties.strokeWidth) * amount;
  result.tracking += finite(properties.tracking) * amount;
  if (properties.lineAnchor !== undefined)
    result.lineAnchor += (bounded(properties.lineAnchor, 0, 100, 50) - 50) * amount;
  addVector2(result.lineSpacing, properties.lineSpacing, amount);
  addVector2(result.blur, properties.blur, amount);
  const characterRange = properties.characterRange ?? "preserveCaseAndDigits";
  if (properties.characterOffset !== undefined)
    result.codePoint = offsetCodePoint(
      result.codePoint,
      finite(properties.characterOffset) * amount,
      characterRange,
    );
  if (properties.characterValue !== undefined) {
    const target = rangedCharacterValue(
      result.codePoint,
      normalizeCodePoint(properties.characterValue),
      characterRange,
    );
    result.codePoint = normalizeCodePoint(result.codePoint + (target - result.codePoint) * amount);
  }
  if (properties.fillColor) {
    result.fillColor = blendColor(
      result.fillColor ?? properties.fillColor,
      properties.fillColor,
      amount,
    );
  }
  if (properties.strokeColor) {
    result.strokeColor = blendColor(
      result.strokeColor ?? properties.strokeColor,
      properties.strokeColor,
      amount,
    );
  }
}

function addVector3(
  target: [number, number, number],
  value: [number, number, number] | undefined,
  amount: number,
): void {
  if (!value) return;
  for (let index = 0; index < 3; index += 1) target[index] += finite(value[index]) * amount;
}

function addVector2(
  target: [number, number],
  value: [number, number] | undefined,
  amount: number,
): void {
  if (!value) return;
  for (let index = 0; index < 2; index += 1) target[index] += finite(value[index]) * amount;
}

function multiplyScale(
  target: [number, number, number],
  value: [number, number, number] | undefined,
  amount: number,
): void {
  if (!value) return;
  for (let index = 0; index < 3; index += 1)
    target[index] *= 1 + (bounded(value[index], -10_000, 10_000, 100) / 100 - 1) * amount;
}

function blendColor(
  source: TextAnimatorColor,
  target: TextAnimatorColor,
  amount: number,
): TextAnimatorColor {
  const mix = clamp(amount, 0, 1);
  return normalizeColor(
    source.map(
      (value, index) => value + (finite(target[index]) - value) * mix,
    ) as TextAnimatorColor,
  );
}

function evaluatedProperties(
  properties: TextAnimatorProperties,
  rawTime: number,
): EvaluatedTextAnimatorProperties {
  const time = finite(rawTime);
  const cached = evaluatedPropertiesCache.get(properties);
  if (cached && Object.is(cached.time, time)) return cached;
  const evaluated: EvaluatedTextAnimatorProperties = {
    time,
    ...(properties.anchorPoint
      ? { anchorPoint: evaluateVector3(properties.anchorPoint, time) }
      : {}),
    ...(properties.position ? { position: evaluateVector3(properties.position, time) } : {}),
    ...(properties.scale ? { scale: evaluateVector3(properties.scale, time) } : {}),
    ...(properties.rotation ? { rotation: evaluateVector3(properties.rotation, time) } : {}),
    ...evaluateOptionalScalars(properties, time),
    ...(properties.fillColor ? { fillColor: evaluateColor(properties.fillColor, time) } : {}),
    ...(properties.strokeColor ? { strokeColor: evaluateColor(properties.strokeColor, time) } : {}),
    ...(properties.lineAnchor
      ? { lineAnchor: finite(evaluateAnimatable(properties.lineAnchor, time)) }
      : {}),
    ...(properties.characterRange ? { characterRange: properties.characterRange } : {}),
    ...(properties.lineSpacing
      ? { lineSpacing: evaluateVector2(properties.lineSpacing, time) }
      : {}),
    ...(properties.blur ? { blur: evaluateVector2(properties.blur, time) } : {}),
  };
  evaluatedPropertiesCache.set(properties, evaluated);
  return evaluated;
}

function evaluateOptionalScalars(
  properties: TextAnimatorProperties,
  time: number,
): Partial<EvaluatedTextAnimatorProperties> {
  const result: Partial<EvaluatedTextAnimatorProperties> = {};
  for (const field of [
    "skew",
    "skewAxis",
    "opacity",
    "strokeWidth",
    "tracking",
    "characterOffset",
    "characterValue",
  ] as const) {
    const property = properties[field];
    if (property) result[field] = finite(evaluateAnimatable(property, time));
  }
  return result;
}

function evaluateColor(color: TextAnimatorColorProperty, time: number): TextAnimatorColor {
  return color.map((channel) => finite(evaluateAnimatable(channel, time))) as TextAnimatorColor;
}

function evaluateVector2(value: TextAnimatorVector2Property, time: number): [number, number] {
  return value.map((property) => finite(evaluateAnimatable(property, time))) as [number, number];
}

function evaluateVector3(
  value: TextAnimatorVector3Property,
  time: number,
): [number, number, number] {
  return value.map((property) => finite(evaluateAnimatable(property, time))) as [
    number,
    number,
    number,
  ];
}

function normalizeColor(color: TextAnimatorColor): TextAnimatorColor {
  return color.map((channel) => bounded(channel, 0, 1, 0)) as TextAnimatorColor;
}

function collectLineStarts(text: string): number[] {
  const starts = [0];
  const expression = /\r\n|[\n\r\u2028\u2029]/gu;
  for (const match of text.matchAll(expression)) starts.push((match.index ?? 0) + match[0].length);
  return starts;
}

function findLineIndex(lineStarts: readonly number[], sourceIndex: number): number {
  let low = 0;
  let high = lineStarts.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if ((lineStarts[middle] ?? 0) <= sourceIndex) low = middle + 1;
    else high = middle;
  }
  return Math.max(0, low - 1);
}

function isLineBreak(value: string): boolean {
  return /^(?:\r\n|[\n\r\u2028\u2029])$/u.test(value);
}

function isWhitespace(value: string): boolean {
  return /^\s+$/u.test(value);
}

function normalizeCodePoint(value: number | undefined): number {
  const codePoint = Math.round(bounded(value, 0, 0x10ffff, 0xfffd));
  return codePoint >= 0xd800 && codePoint <= 0xdfff ? 0xfffd : codePoint;
}

function offsetCodePoint(
  source: number,
  offset: number,
  characterRange: TextCharacterRange,
): number {
  if (characterRange === "fullUnicode") return normalizeCodePoint(source + offset);
  const range = preservedCharacterRange(source);
  if (!range) return normalizeCodePoint(source + offset);
  return wrapCodePoint(source + Math.round(offset), range[0], range[1]);
}

function rangedCharacterValue(
  source: number,
  target: number,
  characterRange: TextCharacterRange,
): number {
  if (characterRange === "fullUnicode") return target;
  const sourceRange = preservedCharacterRange(source);
  if (!sourceRange) return target;
  const targetRange = preservedCharacterRange(target);
  if (targetRange && targetRange[1] - targetRange[0] === sourceRange[1] - sourceRange[0])
    return sourceRange[0] + (target - targetRange[0]);
  return wrapCodePoint(target, sourceRange[0], sourceRange[1]);
}

function preservedCharacterRange(codePoint: number): readonly [number, number] | undefined {
  if (codePoint >= 0x41 && codePoint <= 0x5a) return [0x41, 0x5a];
  if (codePoint >= 0x61 && codePoint <= 0x7a) return [0x61, 0x7a];
  if (codePoint >= 0x30 && codePoint <= 0x39) return [0x30, 0x39];
  return undefined;
}

function wrapCodePoint(value: number, minimum: number, maximum: number): number {
  const length = maximum - minimum + 1;
  return minimum + ((((Math.round(value) - minimum) % length) + length) % length);
}

function finite(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function bounded(
  value: number | undefined,
  minimum: number,
  maximum: number,
  fallback: number,
): number {
  const normalized = typeof value === "number" && Number.isFinite(value) ? value : fallback;
  return clamp(normalized, minimum, maximum);
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}
