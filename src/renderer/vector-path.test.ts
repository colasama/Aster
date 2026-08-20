import { describe, expect, it } from "vitest";
import type { BezierPath } from "../core/types";
import { flattenBezierPath, tessellateStroke, triangulatePolygon } from "./vector-path";

const curve: BezierPath = {
  closed: false,
  vertices: [
    { position: [-0.5, 0.25], inTangent: [0, 0], outTangent: [0.3, -0.5] },
    { position: [0.5, -0.25], inTangent: [-0.3, 0.5], outTangent: [0, 0] },
  ],
};

describe("Bezier path tessellation", () => {
  it("adaptively flattens cubic handles while preserving endpoints", () => {
    const points = flattenBezierPath(curve, 0.001);
    expect(points.length).toBeGreaterThan(8);
    expect(points[0]).toEqual(curve.vertices[0].position);
    expect(points[points.length - 1]).toEqual(curve.vertices[1].position);
    expect(points.every((point) => point.every(Number.isFinite))).toBe(true);
  });

  it("triangulates a concave closed polygon", () => {
    const triangles = triangulatePolygon([
      [-1, -1],
      [1, -1],
      [0.2, 0],
      [1, 1],
      [-1, 1],
    ]);
    expect(triangles).toHaveLength(9);
  });

  it.each(["miter", "bevel", "round"] as const)(
    "creates finite %s joins and round caps",
    (join) => {
      const triangles = tessellateStroke(
        [
          [0, 0],
          [100, 0],
          [120, 80],
        ],
        12,
        false,
        join,
        "round",
      );
      expect(triangles.length).toBeGreaterThan(12);
      expect(triangles.every((point) => point.every(Number.isFinite))).toBe(true);
    },
  );
});
