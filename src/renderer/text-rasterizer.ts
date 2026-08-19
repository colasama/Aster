import type { Layer } from "../core/types";

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
  drawTextLayer(context, layer, width, height, false);
  return { width, height, pixels: context.getImageData(0, 0, width, height).data };
}

export function drawTextLayer(
  context: CanvasRenderingContext2D,
  layer: Layer,
  width: number,
  height: number,
  useLayerColor = true,
): void {
  const hero = layer.name === "ASTER";
  const text = layer.text ?? layer.name;
  const fontSize = height * (hero ? 0.82 : 0.56);
  const tracking = fontSize * (hero ? 0.15 : 0.34);
  context.font = `${hero ? 800 : 600} ${fontSize}px Inter, "Segoe UI", sans-serif`;
  context.textAlign = "left";
  context.textBaseline = "middle";
  context.shadowColor = hero ? "rgba(80, 125, 255, 0.55)" : "rgba(2, 4, 12, 0.8)";
  context.shadowBlur = fontSize * (hero ? 0.1 : 0.035);
  context.shadowOffsetY = fontSize * 0.015;
  if (hero && !useLayerColor) {
    const gradient = context.createLinearGradient(width * 0.12, 0, width * 0.88, height);
    gradient.addColorStop(0, "#ffffff");
    gradient.addColorStop(0.55, "#b5ceff");
    gradient.addColorStop(1, "#8d74ef");
    context.fillStyle = gradient;
  } else if (useLayerColor) {
    const [red, green, blue] = layer.color;
    context.fillStyle = `rgb(${Math.round(red * 255)} ${Math.round(green * 255)} ${Math.round(blue * 255)})`;
  } else {
    context.fillStyle = "white";
  }
  drawTrackedText(context, text, width / 2, height / 2, tracking, width * 0.94);
}

function drawTrackedText(
  context: CanvasRenderingContext2D,
  text: string,
  centerX: number,
  centerY: number,
  tracking: number,
  maximumWidth: number,
): void {
  const glyphs = Array.from(text);
  const widths = glyphs.map((glyph) => context.measureText(glyph).width);
  const naturalWidth =
    widths.reduce((sum, width) => sum + width, 0) + Math.max(0, glyphs.length - 1) * tracking;
  const horizontalScale = Math.min(1, maximumWidth / Math.max(naturalWidth, 1));
  context.save();
  context.translate(centerX, centerY);
  context.scale(horizontalScale, 1);
  let cursor = -naturalWidth / 2;
  for (let index = 0; index < glyphs.length; index += 1) {
    context.fillText(glyphs[index], cursor, 0);
    cursor += widths[index] + tracking;
  }
  context.restore();
}
