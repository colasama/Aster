import { EvaluationCache } from "../../core/animation/evaluation-cache";
import type { BezierPath, ShapeSettings } from "../../core/types";
import {
  flattenBezierPath,
  type Point2,
  tessellateStroke,
  triangulatePolygon,
  trimPolyline,
} from "./vector-path";

interface BezierGeometry {
  fill: readonly Point2[];
  stroke: readonly Point2[];
  estimatedBytes: number;
}

// Local-space topology survives frame changes; paint and world/camera transforms do not.
// Lazily constructed: module-level instantiation breaks when the bundler orders this
// chunk ahead of the chunk defining EvaluationCache.
let cache: EvaluationCache<BezierGeometry> | undefined;

function bezierCache(): EvaluationCache<BezierGeometry> {
  if (!cache) {
    cache = new EvaluationCache<BezierGeometry>({
      capacity: 128,
      maxBytes: 8 * 1024 * 1024,
      sizeOf: (value) => value.estimatedBytes,
    });
  }
  return cache;
}

export function cachedBezierGeometry(
  path: BezierPath,
  shape: ShapeSettings,
  width: number,
  height: number,
): BezierGeometry {
  const stroked = shape.strokeWidth > 0;
  const trim = shape.trim ?? { start: 0, end: 100, offset: 0 };
  // Content keys also detect edits made in place. Include exact signed dimensions:
  // stroke tessellation depends on scale, including fractional and mirrored scale.
  const signature = JSON.stringify([
    path,
    stroked
      ? [width, height, shape.strokeWidth, trim, shape.lineJoin ?? "round", shape.lineCap]
      : null,
  ]);
  const key = { nodeId: signature, revision: 0 };
  const hit = bezierCache().get(key);
  if (hit) return hit;

  const normalized = flattenBezierPath(path);
  const fill = path.closed ? triangulatePolygon(normalized) : [];
  const stroke: Point2[] = [];
  if (stroked) {
    const scaled = normalized.map((point): Point2 => [point[0] * width, point[1] * height]);
    const segments = trimPolyline(
      scaled,
      path.closed,
      trim.start / 100,
      trim.end / 100,
      trim.offset / 100,
    );
    for (const segment of segments) {
      const triangles = tessellateStroke(
        segment.points,
        shape.strokeWidth,
        segment.closed,
        shape.lineJoin ?? "round",
        shape.lineCap,
      );
      for (const point of triangles)
        stroke.push([point[0] / (width || 1), point[1] / (height || 1)]);
    }
  }
  const value = {
    fill,
    stroke,
    // Conservatively account for JS point arrays, references, and both stored key strings.
    estimatedBytes: (fill.length + stroke.length) * 80 + signature.length * 4,
  };
  bezierCache().set(key, value);
  return value;
}
