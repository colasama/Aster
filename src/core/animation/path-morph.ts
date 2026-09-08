import type { BezierPath, ShapeSettings } from "../types";
import { evaluateExpression } from "./expressions";
import { evaluateAnimatable } from "./timeline";

export function assertMatchingPathTopology(
  source: BezierPath | undefined,
  target: BezierPath,
): void {
  if (
    !source ||
    source.closed !== target.closed ||
    source.vertices.length !== target.vertices.length
  )
    throw new Error("Path morph requires matching vertex counts and open/closed topology");
}

/** Only control points are interpolated; tessellation and compositing remain in the geometry path. */
export function evaluateShapePath(
  shape: ShapeSettings,
  time: number,
  expression?: string,
): BezierPath | undefined {
  const source = shape.path;
  const morph = shape.morph;
  if (!source || !morph) return source;
  let value = evaluateAnimatable(morph.progress, time);
  if (expression) {
    try {
      value = evaluateExpression(expression, { time, value });
    } catch {
      /* Retain the keyed value for invalid expressions. */
    }
  }
  const progress = Math.max(0, Math.min(1, value / 100));
  if (progress === 0) return source;
  if (progress === 1) return morph.target;
  return {
    closed: source.closed,
    vertices: source.vertices.map((vertex, index) => {
      const target = morph.target.vertices[index];
      const lerp = (key: "position" | "inTangent" | "outTangent"): [number, number] => [
        vertex[key][0] + (target[key][0] - vertex[key][0]) * progress,
        vertex[key][1] + (target[key][1] - vertex[key][1]) * progress,
      ];
      return {
        position: lerp("position"),
        inTangent: lerp("inTangent"),
        outTangent: lerp("outTangent"),
      };
    }),
  };
}
