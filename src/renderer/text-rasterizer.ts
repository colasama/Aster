import type { Layer, TextStyle } from "../core/types";

export interface RasterizedText {
  width: number;
  height: number;
  pixels: Uint8ClampedArray;
}

export function rasterizeTextLayer(layer: Layer, maximumDimension: number): RasterizedText {
  const sourceWidth = Math.max(1, layer.size[0]);
  const sourceHeight = Math.max(1, layer.size[1]);
  const scale = Math.min(1, maximumDimension / Math.max(sourceWidth, sourceHeight));
  const width = Math.max(1, Math.ceil(sourceWidth * scale));
  const height = Math.max(1, Math.ceil(sourceHeight * scale));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("Text rasterization canvas is unavailable");
  drawTextLayer(context, layer, width, height);
  return { width, height, pixels: context.getImageData(0, 0, width, height).data };
}

export function drawTextLayer(
  context: CanvasRenderingContext2D,
  layer: Layer,
  width: number,
  height: number,
): void {
  const sourceScale = width / Math.max(1, layer.size[0]);
  const style = resolvedStyle(layer);
  const fontSize = style.fontSize * sourceScale;
  const tracking = style.tracking * sourceScale;
  const leading = style.leading * sourceScale;
  const strokeWidth = style.strokeWidth * sourceScale;
  context.font = `${style.fontWeight} ${fontSize}px ${style.fontFamily}`;
  context.textAlign = "left";
  context.textBaseline = "middle";
  context.lineJoin = "round";
  context.miterLimit = 2;
  context.shadowColor = "rgba(40, 72, 180, 0.28)";
  context.shadowBlur = fontSize * 0.045;
  context.shadowOffsetY = fontSize * 0.012;
  context.fillStyle = cssColor(layer.color);
  context.strokeStyle = cssColor(style.strokeColor);
  context.lineWidth = strokeWidth * 2;

  const lines = (layer.text ?? layer.name).split(/\r?\n/).slice(0, 256);
  const blockHeight = fontSize + Math.max(0, lines.length - 1) * leading;
  const firstBaseline = (height - blockHeight) / 2 + fontSize / 2;
  for (let index = 0; index < lines.length; index += 1) {
    drawTrackedLine(
      context,
      lines[index],
      width * 0.03,
      firstBaseline + index * leading,
      tracking,
      width * 0.94,
      style.alignment,
      strokeWidth > 0,
    );
  }
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
): void {
  const glyphs = Array.from(text);
  const widths = glyphs.map((glyph) => context.measureText(glyph).width);
  const naturalWidth =
    widths.reduce((sum, width) => sum + width, 0) + Math.max(0, glyphs.length - 1) * tracking;
  const horizontalScale = Math.min(1, maximumWidth / Math.max(naturalWidth, 1));
  const renderedWidth = naturalWidth * horizontalScale;
  const alignedLeft =
    alignment === "left"
      ? left
      : alignment === "right"
        ? left + maximumWidth - renderedWidth
        : left + (maximumWidth - renderedWidth) / 2;
  context.save();
  context.translate(alignedLeft, baseline);
  context.scale(horizontalScale, 1);
  let cursor = 0;
  for (let index = 0; index < glyphs.length; index += 1) {
    if (stroke) context.strokeText(glyphs[index], cursor, 0);
    context.fillText(glyphs[index], cursor, 0);
    cursor += widths[index] + tracking;
  }
  context.restore();
}

function resolvedStyle(layer: Layer): TextStyle {
  const hero = layer.name === "ASTER";
  return (
    layer.textStyle ?? {
      fontFamily: 'Inter, "Segoe UI", sans-serif',
      fontSize: layer.size[1] * (hero ? 0.82 : 0.56),
      fontWeight: hero ? 800 : 600,
      alignment: "center",
      tracking: layer.size[1] * (hero ? 0.15 : 0.34),
      leading: layer.size[1] * 0.72,
      strokeWidth: 0,
      strokeColor: [0, 0, 0, 1],
    }
  );
}

function cssColor(color: readonly [number, number, number, number]): string {
  return `rgba(${Math.round(color[0] * 255)}, ${Math.round(color[1] * 255)}, ${Math.round(color[2] * 255)}, ${color[3]})`;
}
