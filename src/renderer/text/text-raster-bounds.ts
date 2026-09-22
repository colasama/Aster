/** Local-space ink bounds, independent of the paragraph's layout box. */
export interface TextRasterBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function includeTextBounds(target: TextRasterBounds, ink: TextRasterBounds): void {
  const right = Math.max(target.x + target.width, ink.x + ink.width);
  const bottom = Math.max(target.y + target.height, ink.y + ink.height);
  target.x = Math.min(target.x, ink.x);
  target.y = Math.min(target.y, ink.y);
  target.width = right - target.x;
  target.height = bottom - target.y;
}

/** Measure the same transformed ink that is painted, including stroke and blur support. */
export function paintText(
  context: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  stroke: boolean,
  bounds?: TextRasterBounds,
): void {
  if (!bounds) {
    if (stroke) context.strokeText(text, x, y);
    context.fillText(text, x, y);
    return;
  }
  const metrics = context.measureText(text);
  const fontSize = Number.parseFloat(context.font.match(/[\d.]+px/u)?.[0] ?? "16");
  const strokeRadius = stroke ? context.lineWidth / 2 : 0;
  const left = x - (metrics.actualBoundingBoxLeft ?? 0) - strokeRadius;
  const right = x + (metrics.actualBoundingBoxRight ?? metrics.width) + strokeRadius;
  const top = y - (metrics.actualBoundingBoxAscent ?? fontSize / 2) - strokeRadius;
  const bottom = y + (metrics.actualBoundingBoxDescent ?? fontSize / 2) + strokeRadius;
  const matrix = context.getTransform();
  const corners = [
    [left, top],
    [right, top],
    [left, bottom],
    [right, bottom],
  ];
  const xs = corners.map(([px, py]) => matrix.a * px + matrix.c * py + matrix.e);
  const ys = corners.map(([px, py]) => matrix.b * px + matrix.d * py + matrix.f);
  // Canvas filters operate in canvas pixels rather than the glyph's transformed space.
  const padding =
    1 + 3 * Number.parseFloat(context.filter.match(/blur\(([\d.]+)px\)/u)?.[1] ?? "0");
  const minX = Math.floor(Math.min(...xs) - padding);
  const minY = Math.floor(Math.min(...ys) - padding);
  includeTextBounds(bounds, {
    x: minX,
    y: minY,
    width: Math.ceil(Math.max(...xs) + padding) - minX,
    height: Math.ceil(Math.max(...ys) + padding) - minY,
  });
}
