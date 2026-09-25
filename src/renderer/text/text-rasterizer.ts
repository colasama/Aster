import {
  type EvaluatedTextAnimatorCharacter,
  evaluateTextAnimatorStack,
  segmentTextLayoutUnits,
  type TextLayoutUnit,
} from "../../core/animation/text-animator-stack";
import { safeEvaluateTextSelectorExpression } from "../../core/animation/text-selector-expression";
import { resolveTextStyle } from "../../core/layers/text-style";

export { resolveTextStyle } from "../../core/layers/text-style";

import type { Layer, TextStyle } from "../../core/types";
import { paintText, type TextRasterBounds } from "./text-raster-bounds";

export interface RasterizedText {
  width: number;
  height: number;
  canvas: HTMLCanvasElement;
  bounds?: TextRasterBounds;
}

/** Shared preview/export bucket used by ordinary and temporal text raster generations. */
export function textRasterResolutionScale(value: number): number {
  const bounded = Number.isFinite(value) ? Math.max(1, Math.min(8, value)) : 1;
  return Math.min(8, 1.25 ** Math.ceil(Math.log(bounded) / Math.log(1.25)));
}

/** Include evaluated parent transforms before selecting the bounded raster-density bucket. */
export function transformedTextRasterScale(
  resolutionScale: number,
  scale: readonly number[],
): number {
  const magnification = Math.max(Math.abs(scale[0]), Math.abs(scale[1])) / 100;
  return textRasterResolutionScale(resolutionScale * magnification);
}

export function rasterizeTextLayer(
  layer: Layer,
  maximumDimension: number,
  localTime = 0,
  resolutionScale = 1,
  bounds = measureTextLayerBounds(layer, localTime),
): RasterizedText {
  const { width, height } = textRasterSize(
    { size: [bounds.width, bounds.height] },
    maximumDimension,
    resolutionScale,
  );
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  // The raster uploads through copyExternalImageToTexture, so a GPU-backed canvas keeps the
  // glyph pixels on the GPU instead of forcing a Canvas2D readback round trip.
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Text rasterization canvas is unavailable");
  const scale = width / bounds.width;
  context.scale(1, height / bounds.height / scale);
  context.translate(-bounds.x * scale, -bounds.y * scale);
  drawTextLayer(context, layer, layer.size[0] * scale, layer.size[1] * scale, localTime);
  return { width, height, bounds, canvas };
}

let measureContext: CanvasRenderingContext2D | undefined;

function textMeasureContext(): CanvasRenderingContext2D {
  if (measureContext) return measureContext;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 1;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Text measurement canvas is unavailable");
  measureContext = context;
  return context;
}

export function measureTextLayerBounds(layer: Layer, localTime = 0): TextRasterBounds {
  const context = textMeasureContext();
  const bounds = {
    x: 0,
    y: 0,
    width: Math.max(1, layer.size[0]),
    height: Math.max(1, layer.size[1]),
  };
  drawTextLayer(context, layer, layer.size[0], layer.size[1], localTime, bounds);
  return bounds;
}

export function textRasterSize(
  layer: Pick<Layer, "size">,
  maximumDimension: number,
  resolutionScale = 1,
): { width: number; height: number } {
  const sourceWidth = Math.max(1, layer.size[0]);
  const sourceHeight = Math.max(1, layer.size[1]);
  const requestedScale = Number.isFinite(resolutionScale) ? Math.max(1, resolutionScale) : 1;
  const scale = Math.min(
    requestedScale,
    Math.max(1, maximumDimension) / Math.max(sourceWidth, sourceHeight),
  );
  return {
    width: Math.max(1, Math.ceil(sourceWidth * scale)),
    height: Math.max(1, Math.ceil(sourceHeight * scale)),
  };
}

export function drawTextLayer(
  context: CanvasRenderingContext2D,
  layer: Layer,
  width: number,
  height: number,
  localTime = 0,
  bounds?: TextRasterBounds,
): void {
  const sourceScale = width / Math.max(1, layer.size[0]);
  const style = resolveTextStyle(layer);
  const fontSize = style.fontSize * sourceScale;
  const tracking = style.tracking * sourceScale;
  const leading = style.leading * sourceScale;
  const strokeWidth = style.strokeWidth * sourceScale;
  context.font = `${style.fontStyle ?? "normal"} ${style.fontWeight} ${fontSize}px ${style.fontFamily}`;
  context.textAlign = "left";
  context.textBaseline = "middle";
  context.lineJoin = "round";
  context.miterLimit = 2;
  context.shadowColor = "transparent";
  context.shadowBlur = 0;
  context.shadowOffsetX = 0;
  context.shadowOffsetY = 0;
  context.fillStyle = cssColor(layer.color);
  context.strokeStyle = cssColor(style.strokeColor);
  context.lineWidth = strokeWidth * 2;

  const maximumWidth = width * 0.94;
  const lines = breakTextLines(
    layer.text ?? layer.name,
    maximumWidth,
    (text) => context.measureText(text).width,
    tracking,
  );
  const blockHeight = fontSize + Math.max(0, lines.length - 1) * leading;
  const firstBaseline = (height - blockHeight) / 2 + fontSize / 2;
  const animation = animationCursor(layer, style, lines, localTime, sourceScale);
  for (let index = 0; index < lines.length; index += 1) {
    drawTrackedLine(
      context,
      lines[index],
      width * 0.03,
      firstBaseline + index * leading,
      tracking,
      maximumWidth,
      style.alignment,
      strokeWidth > 0,
      animation,
      index,
      bounds,
    );
  }
}

interface TextAnimationCursor {
  characterIndex: number;
  fillColor: [number, number, number, number];
  groups: NonNullable<Layer["textAnimator"]>["groups"];
  localTime: number;
  sourceScale: number;
  strokeColor: [number, number, number, number];
  strokeWidth: number;
  units: readonly TextLayoutUnit[];
}

function animationCursor(
  layer: Layer,
  style: ReturnType<typeof resolveTextStyle>,
  lines: readonly string[],
  localTime: number,
  sourceScale: number,
): TextAnimationCursor | undefined {
  if (!layer.textAnimator?.enabled) return undefined;
  return {
    characterIndex: 0,
    groups: layer.textAnimator.groups,
    localTime,
    fillColor: layer.color,
    sourceScale,
    strokeColor: style.strokeColor,
    strokeWidth: style.strokeWidth,
    units: segmentTextLayoutUnits(lines.join("\n")),
  };
}

function drawTrackedLine(
  context: CanvasRenderingContext2D,
  text: string,
  left: number,
  baseline: number,
  tracking: number,
  maximumWidth: number,
  alignment: TextStyle["alignment"],
  stroke: boolean,
  animation: TextAnimationCursor | undefined,
  visualLineIndex: number,
  bounds?: TextRasterBounds,
): void {
  const glyphs = graphemes(text);
  const widths = glyphs.map((glyph) => context.measureText(glyph).width);
  const naturalWidth =
    Math.abs(tracking) < 0.000_01
      ? context.measureText(text).width
      : widths.reduce((total, width) => total + width, 0) +
        Math.max(0, glyphs.length - 1) * tracking;
  const renderedWidth = naturalWidth;
  const alignedLeft =
    alignment === "left"
      ? left
      : alignment === "right"
        ? left + maximumWidth - renderedWidth
        : left + (maximumWidth - renderedWidth) / 2;
  context.save();
  context.translate(alignedLeft, baseline);
  if (!animation && Math.abs(tracking) < 0.000_01) {
    paintText(context, text, 0, 0, stroke, bounds);
    context.restore();
    return;
  }
  const states = animation ? glyphs.map((glyph) => evaluateGlyph(animation, glyph)) : undefined;
  const renderedGlyphs =
    states?.map((state, index) => replacementGlyph(state, glyphs[index])) ?? glyphs;
  const renderedWidths = renderedGlyphs.map((glyph, index) =>
    glyph === glyphs[index]
      ? (widths[index] ?? context.measureText(glyph).width)
      : context.measureText(glyph).width,
  );
  let trackingDelta = 0;
  let lineAnchorCompensation = 0;
  if (states)
    for (let index = 0; index < states.length - 1; index += 1) {
      const state = states[index];
      const delta = (state?.tracking ?? 0) * (animation?.sourceScale ?? 1);
      trackingDelta += delta;
      lineAnchorCompensation += delta * ((state?.lineAnchor ?? 50) / 100);
    }
  const animatedWidth = states
    ? renderedWidths.reduce(
        (total, glyphWidth, index) =>
          total +
          glyphWidth +
          (index < renderedWidths.length - 1
            ? tracking + (states[index]?.tracking ?? 0) * (animation?.sourceScale ?? 1)
            : 0),
        0,
      )
    : naturalWidth;
  if (states) {
    context.restore();
    context.save();
    const widthBeforeAnimatorTracking = animatedWidth - trackingDelta;
    const baseAlignedLeft =
      alignment === "left"
        ? left
        : alignment === "right"
          ? left + maximumWidth - widthBeforeAnimatorTracking
          : left + (maximumWidth - widthBeforeAnimatorTracking) / 2;
    const animatedLeft = baseAlignedLeft - lineAnchorCompensation;
    context.translate(animatedLeft, baseline);
  }
  let cursor = 0;
  for (let index = 0; index < glyphs.length; index += 1) {
    const glyph = renderedGlyphs[index] ?? glyphs[index] ?? "";
    const glyphWidth = renderedWidths[index] ?? widths[index] ?? 0;
    const state = states?.[index];
    if (animation && state) {
      drawAnimatedGlyph(
        context,
        glyph,
        glyphWidth,
        cursor,
        state,
        animation.sourceScale,
        stroke,
        visualLineIndex,
        bounds,
      );
    } else {
      paintText(context, glyph, cursor, 0, stroke, bounds);
    }
    cursor += glyphWidth + tracking + (state?.tracking ?? 0) * (animation?.sourceScale ?? 1);
  }
  context.restore();
}

function evaluateGlyph(
  animation: TextAnimationCursor,
  glyph: string,
): EvaluatedTextAnimatorCharacter {
  const unit = animation.units[animation.characterIndex];
  animation.characterIndex += 1;
  const codePoint = glyph.codePointAt(0) ?? 0xfffd;
  return evaluateTextAnimatorStack(
    animation.groups,
    unit ?? {
      characterIndex: animation.characterIndex - 1,
      characterCount: animation.units.length,
      characterExcludingSpacesIndex: animation.characterIndex - 1,
      characterExcludingSpacesCount: animation.units.length,
      wordIndex: 0,
      wordCount: 1,
      lineIndex: 0,
      lineCount: 1,
      isWhitespace: /^\s+$/u.test(glyph),
    },
    {
      time: animation.localTime,
      evaluateExpression: safeEvaluateTextSelectorExpression,
      baseStyle: {
        codePoint,
        fillColor: animation.fillColor,
        strokeColor: animation.strokeColor,
        strokeWidth: animation.strokeWidth,
      },
    },
  );
}

/**
 * Stable fingerprint of the glyph states a raster would draw at this time. Textures may be
 * retained whenever the signature matches, even while the sampled animation time keeps moving.
 */
export function textRasterSignature(layer: Layer, localTime: number): number {
  const style = resolveTextStyle(layer);
  const context = textMeasureContext();
  context.font = `${style.fontStyle ?? "normal"} ${style.fontWeight} ${style.fontSize}px ${style.fontFamily}`;
  const lines = breakTextLines(
    layer.text ?? layer.name,
    layer.size[0] * 0.94,
    (text) => context.measureText(text).width,
    style.tracking,
  );
  const animation = animationCursor(layer, style, lines, localTime, 1);
  let hash = 0x811c9dc5;
  const fold = (value: number) => {
    hash ^= Math.round((Number.isFinite(value) ? value : 0) * 4096);
    hash = Math.imul(hash, 0x01000193);
  };
  const foldVector = (values: readonly number[] | undefined) => {
    fold(values ? values.length : -1);
    for (const value of values ?? []) fold(value);
  };
  fold(lines.length);
  fold(animation ? 1 : -1);
  for (const line of lines)
    for (const glyph of graphemes(line)) {
      fold(glyph.codePointAt(0) ?? 0);
      if (!animation) continue;
      const state = evaluateGlyph(animation, glyph);
      foldVector(state.anchorPoint);
      foldVector(state.position);
      foldVector(state.scale);
      foldVector(state.rotation);
      fold(state.skew);
      fold(state.skewAxis);
      fold(state.opacity);
      foldVector(state.fillColor);
      foldVector(state.strokeColor);
      fold(state.strokeWidth);
      fold(state.tracking);
      fold(state.lineAnchor);
      foldVector(state.lineSpacing);
      fold(state.codePoint);
      foldVector(state.blur);
    }
  return hash >>> 0;
}

function replacementGlyph(
  state: EvaluatedTextAnimatorCharacter,
  original: string | undefined,
): string {
  const originalCodePoint = original?.codePointAt(0) ?? 0xfffd;
  return state.codePoint === originalCodePoint
    ? (original ?? "")
    : String.fromCodePoint(state.codePoint);
}

function drawAnimatedGlyph(
  context: CanvasRenderingContext2D,
  glyph: string,
  glyphWidth: number,
  cursor: number,
  state: EvaluatedTextAnimatorCharacter,
  sourceScale: number,
  stroke: boolean,
  visualLineIndex: number,
  bounds?: TextRasterBounds,
): void {
  const radians = Math.PI / 180;
  const projectedZ = state.position[2] + state.anchorPoint[2] * (1 - state.scale[2]);
  const depth = Math.max(0.01, Math.min(100, 1 / (1 + projectedZ / 1000)));
  const scaleX = state.scale[0] * Math.cos(state.rotation[1] * radians) * depth;
  const scaleY = state.scale[1] * Math.cos(state.rotation[0] * radians) * depth;
  const anchorX = state.anchorPoint[0] * sourceScale;
  const anchorY = state.anchorPoint[1] * sourceScale;
  const lineOffsetX = state.lineSpacing[0] * sourceScale * visualLineIndex;
  const lineOffsetY = state.lineSpacing[1] * sourceScale * visualLineIndex;
  context.save();
  context.globalAlpha *= state.opacity;
  context.fillStyle = cssColor(state.fillColor ?? [1, 1, 1, 1]);
  context.strokeStyle = cssColor(state.strokeColor ?? [0, 0, 0, 1]);
  context.lineWidth = state.strokeWidth * sourceScale * 2;
  const blur = Math.max(state.blur[0], state.blur[1]) * sourceScale;
  context.filter = blur > 0.000_01 ? `blur(${blur}px)` : "none";
  context.translate(
    cursor + glyphWidth / 2 + state.position[0] * sourceScale + lineOffsetX,
    state.position[1] * sourceScale + lineOffsetY,
  );
  context.rotate(state.rotation[2] * radians);
  if (Math.abs(state.skew) > 0.000_01) {
    context.rotate(-state.skewAxis * radians);
    // At axis zero, positive skew leans the top of the glyph to the right.
    context.transform(1, 0, -Math.tan(state.skew * radians), 1, 0, 0);
    context.rotate(state.skewAxis * radians);
  }
  context.scale(scaleX, scaleY);
  context.translate(-anchorX, -anchorY);
  paintText(
    context,
    glyph,
    -glyphWidth / 2,
    0,
    (stroke || state.strokeWidth > 0) && state.strokeWidth > 0,
    bounds,
  );
  context.restore();
}

export function breakTextLines(
  text: string,
  maximumWidth: number,
  measure: (text: string) => number,
  tracking = 0,
): string[] {
  const output: string[] = [];
  for (const hardLine of text.split(/\r?\n/)) {
    if (hardLine.length === 0) {
      output.push("");
      continue;
    }
    let line = "";
    for (const token of words(hardLine)) {
      const candidate = line + token;
      if (line.length === 0 || trackedWidth(candidate, measure, tracking) <= maximumWidth) {
        line = candidate;
        continue;
      }
      output.push(line.trimEnd());
      line = token.trimStart();
      if (trackedWidth(line, measure, tracking) <= maximumWidth) continue;
      const clusters = graphemes(line);
      line = "";
      for (const cluster of clusters) {
        if (line.length > 0 && trackedWidth(line + cluster, measure, tracking) > maximumWidth) {
          output.push(line);
          line = cluster;
        } else line += cluster;
      }
    }
    output.push(line.trimEnd());
  }
  return output;
}

function trackedWidth(text: string, measure: (text: string) => number, tracking: number): number {
  if (Math.abs(tracking) < 0.000_01) return measure(text);
  const clusters = graphemes(text);
  return (
    clusters.reduce((total, cluster) => total + measure(cluster), 0) +
    Math.max(0, clusters.length - 1) * tracking
  );
}

function graphemes(text: string): string[] {
  return Array.from(
    new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text),
    (segment) => segment.segment,
  );
}

function words(text: string): string[] {
  return Array.from(
    new Intl.Segmenter(undefined, { granularity: "word" }).segment(text),
    (segment) => segment.segment,
  );
}

function cssColor(color: readonly [number, number, number, number]): string {
  return `rgba(${Math.round(color[0] * 255)}, ${Math.round(color[1] * 255)}, ${Math.round(color[2] * 255)}, ${color[3]})`;
}
