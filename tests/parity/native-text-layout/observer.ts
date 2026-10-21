import { cssFontFamily, resolveTextStyle } from "../../../src/core/layers/text-style";
import type { Layer } from "../../../src/core/types";
import {
  breakTextLines,
  measureTextLayerBounds,
  rasterizeTextLayer,
} from "../../../src/renderer/text/text-rasterizer";

interface TextClusterObservation {
  x: number;
  y: number;
  start: number;
  end: number;
  align: string;
  baseline: string;
  selectionRects?: { x: number; y: number; width: number; height: number }[];
}

type ExtendedMetrics = TextMetrics & {
  getTextClusters?: (start: number, end: number) => TextClusterObservation[];
  getSelectionRects?: (start: number, end: number) => DOMRectReadOnly[];
};

export interface TextDrawObservation {
  operation: "fillText" | "strokeText";
  text: string;
  x: number;
  y: number;
  font: string;
  direction: string;
  textAlign: string;
  textBaseline: string;
  transform: number[];
  lineTransform?: number[];
  opacity: number;
  fill: string;
  stroke: string;
  lineWidth: number;
  filter: string;
  metrics: Record<string, number>;
  clusters: TextClusterObservation[] | null;
}

export function textMetricsValues(metrics: TextMetrics): Record<string, number> {
  const values: Record<string, number> = {};
  for (const key of [
    "width",
    "actualBoundingBoxLeft",
    "actualBoundingBoxRight",
    "actualBoundingBoxAscent",
    "actualBoundingBoxDescent",
    "fontBoundingBoxAscent",
    "fontBoundingBoxDescent",
    "hangingBaseline",
    "alphabeticBaseline",
    "ideographicBaseline",
  ] as const) {
    const value = metrics[key];
    if (!Number.isFinite(value)) throw new Error(`Non-finite text metric: ${key}`);
    values[key] = value;
  }
  return values;
}

/** Observe native context calls without replacing production segmentation, wrapping or animation. */
export function observeTextRaster(
  layer: Layer,
  time: number,
  scale: number,
  maximumDimension: number,
) {
  // Initialize the production singleton before interception so it never retains a proxy.
  const bounds = measureTextLayerBounds(layer, time);
  const original = HTMLCanvasElement.prototype.getContext;
  const observations = new Map<
    HTMLCanvasElement,
    {
      draws: TextDrawObservation[];
      measures: { text: string; font: string; width: number }[];
      lineOrigins: number[][];
    }
  >();
  let calls = 0;
  let characters = 0;
  const spend = (text: string) => {
    calls += 1;
    characters += text.length;
    if (calls > 100_000 || characters > 8_000_000)
      throw new Error("Text observation budget exceeded");
  };
  HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, ...args: unknown[]) {
    const context = Reflect.apply(original, this, args);
    if (args[0] !== "2d" || !context) return context;
    const target = context as CanvasRenderingContext2D;
    const record = {
      draws: [] as TextDrawObservation[],
      measures: [] as { text: string; font: string; width: number }[],
      lineOrigins: [] as number[][],
    };
    observations.set(this, record);
    let depth = 0;
    let lineTransform: number[] | undefined;
    return new Proxy(target, {
      get(object, property) {
        const value = Reflect.get(object, property, object);
        if (typeof value !== "function") return value;
        return (...parameters: unknown[]) => {
          if (property === "fillText" || property === "strokeText") {
            const text = String(parameters[0]);
            spend(text);
            const metrics = object.measureText(text) as ExtendedMetrics;
            const clusters =
              metrics.getTextClusters?.(0, text.length).map((cluster) => ({
                x: cluster.x,
                y: cluster.y,
                start: cluster.start,
                end: cluster.end,
                align: cluster.align,
                baseline: cluster.baseline,
                selectionRects: metrics
                  .getSelectionRects?.(cluster.start, cluster.end)
                  .map((rect) => ({
                    x: rect.x,
                    y: rect.y,
                    width: rect.width,
                    height: rect.height,
                  })),
              })) ?? null;
            record.draws.push({
              operation: property,
              text,
              x: Number(parameters[1]),
              y: Number(parameters[2]),
              font: object.font,
              direction: object.direction,
              textAlign: object.textAlign,
              textBaseline: object.textBaseline,
              transform: Array.from(object.getTransform().toFloat64Array()),
              lineTransform: lineTransform?.slice(),
              opacity: object.globalAlpha,
              fill: String(object.fillStyle),
              stroke: String(object.strokeStyle),
              lineWidth: object.lineWidth,
              filter: object.filter,
              metrics: textMetricsValues(metrics),
              clusters,
            });
          }
          const result = Reflect.apply(value, object, parameters);
          if (property === "measureText") {
            const text = String(parameters[0]);
            spend(text);
            record.measures.push({ text, font: object.font, width: (result as TextMetrics).width });
          }
          if (property === "save") depth += 1;
          if (property === "restore") depth -= 1;
          if (property === "translate" && depth === 1) {
            lineTransform = Array.from(object.getTransform().toFloat64Array());
            record.lineOrigins.push([Number(parameters[0]), Number(parameters[1])]);
          }
          return result;
        };
      },
      set(object, property, value) {
        return Reflect.set(object, property, value, object);
      },
    });
  } as typeof original;
  let raster: ReturnType<typeof rasterizeTextLayer>;
  try {
    raster = rasterizeTextLayer(layer, maximumDimension, time, scale, bounds);
  } finally {
    HTMLCanvasElement.prototype.getContext = original;
  }
  const record = observations.get(raster.canvas);
  if (!record) throw new Error("Production text canvas was not observed");
  const context = raster.canvas.getContext("2d");
  if (!context || !raster.bounds) throw new Error("Text raster context or bounds missing");
  const style = resolveTextStyle(layer);
  const actualScale = raster.width / raster.bounds.width;
  context.save();
  context.font = `${style.fontStyle ?? "normal"} ${style.fontWeight} ${style.fontSize * actualScale}px ${cssFontFamily(style.fontFamily)}`;
  const layoutFont = context.font;
  const lines = breakTextLines(
    layer.text ?? layer.name,
    layer.size[0] * actualScale * 0.94,
    (text) => context.measureText(text).width,
    style.tracking * actualScale,
  );
  context.restore();
  // Animated lines translate once for natural layout and again for animator compensation.
  const originStride = layer.textAnimator?.enabled ? 2 : 1;
  if (record.lineOrigins.length !== lines.length * originStride)
    throw new Error("Production line-origin observation coverage changed");
  return {
    raster,
    observations: {
      draws: record.draws,
      measures: record.measures,
      wrapped_lines: lines,
      scale: actualScale,
      requested_scale: scale,
      layout_font: layoutFont,
      layout_origins: record.lineOrigins.filter((_, index) => index % originStride === 0),
      layout_input: {
        text: layer.text ?? layer.name,
        width: layer.size[0] * actualScale,
        height: layer.size[1] * actualScale,
        font_size: style.fontSize * actualScale,
        tracking: style.tracking * actualScale,
        leading: style.leading * actualScale,
        alignment: style.alignment,
        direction: "left_to_right",
        language: new Intl.Segmenter().resolvedOptions().locale,
        per_grapheme: Boolean(layer.textAnimator?.enabled),
      },
      draw_mode:
        layer.textAnimator?.enabled || Math.abs(style.tracking * actualScale) >= 0.000_01
          ? "per-grapheme"
          : "whole-line",
      cluster_geometry_only: true,
      raw_glyph_identity_available: false,
    },
  };
}
