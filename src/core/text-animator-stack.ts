import {
  evaluateTextSelectors,
  type TextExpressionSelectorEvaluator,
  type TextSelector,
  type TextUnitContext,
} from "./text-selectors";

export const MAX_TEXT_ANIMATOR_GROUPS = 32;
export const MAX_TEXT_LAYOUT_UNITS = 4096;

export type TextAnimatorColor = [number, number, number, number];

export interface TextAnimatorProperties {
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
  lineAnchor?: [number, number];
  lineSpacing?: [number, number];
  characterOffset?: number;
  characterValue?: number;
  blur?: [number, number];
}

export interface TextAnimatorGroup {
  id: string;
  enabled: boolean;
  randomSeed: number;
  selectors: readonly TextSelector[];
  properties: TextAnimatorProperties;
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
  lineAnchor: [number, number];
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
    lineAnchor: [0, 0],
    lineSpacing: [0, 0],
    codePoint: normalizeCodePoint(base?.codePoint),
    blur: [0, 0],
  };
  for (const animator of animators.slice(0, MAX_TEXT_ANIMATOR_GROUPS)) {
    if (!animator.enabled) continue;
    const amount = animator.selectors.length
      ? evaluateTextSelectors(animator.selectors, unit, {
          time: finite(options.time),
          animatorSeed: animator.randomSeed,
          evaluateExpression: options.evaluateExpression,
        })
      : 1;
    applyAnimatorProperties(result, animator.properties, amount);
  }
  result.opacity = clamp(result.opacity, 0, 1);
  result.strokeWidth = Math.max(0, result.strokeWidth);
  result.blur = result.blur.map((value) => Math.max(0, value)) as [number, number];
  result.codePoint = normalizeCodePoint(result.codePoint);
  return result;
}

/** Builds bounded grapheme units and every selector domain in one linear pass. */
export function segmentTextLayoutUnits(text: string): TextLayoutUnit[] {
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
  return graphemes.map((segment, characterIndex) => {
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
}

function applyAnimatorProperties(
  result: EvaluatedTextAnimatorCharacter,
  properties: TextAnimatorProperties,
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
  addVector2(result.lineAnchor, properties.lineAnchor, amount);
  addVector2(result.lineSpacing, properties.lineSpacing, amount);
  addVector2(result.blur, properties.blur, amount);
  result.codePoint += finite(properties.characterOffset) * amount;
  if (properties.characterValue !== undefined)
    result.codePoint += (normalizeCodePoint(properties.characterValue) - result.codePoint) * amount;
  if (properties.fillColor)
    result.fillColor = blendColor(
      result.fillColor ?? properties.fillColor,
      properties.fillColor,
      amount,
    );
  if (properties.strokeColor)
    result.strokeColor = blendColor(
      result.strokeColor ?? properties.strokeColor,
      properties.strokeColor,
      amount,
    );
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
