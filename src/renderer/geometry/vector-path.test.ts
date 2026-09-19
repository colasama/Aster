import { describe, expect, it } from "vitest";
import type { BezierPath } from "../../core/types";
import {
  flattenBezierPath,
  tessellateStroke,
  triangulatePolygon,
  trimPolyline,
} from "./vector-path";

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

  it.each(["miter", "bevel", "round"] as const)(
    "fills the exterior gap for both %s turn directions",
    (join) => {
      for (const direction of [-1, 1]) {
        const triangles = tessellateStroke(
          [
            [0, 0],
            [100, 0],
            [100, direction * 100],
          ],
          20,
          false,
          join,
          "butt",
        );
        // This point is in the outer wedge, beyond both segment rectangles.
        expect(covers(triangles, [103, -direction * 3])).toBe(true);
        expect(covers(triangles, [113, -direction * 13])).toBe(false);
      }
    },
  );

  it("covers the outer edge of a broad curved stroke without radial cracks", () => {
    const arc: BezierPath = {
      closed: false,
      vertices: [
        { position: [0, -2.2], inTangent: [0, 0], outTangent: [-0.8, 1.45] },
        { position: [0, 2.2], inTangent: [-0.8, -1.45], outTangent: [0, 0] },
      ],
    };
    const points = flattenBezierPath(arc).map(([x, y]) => [x * 100, y * 100] as [number, number]);
    const triangles = tessellateStroke(points, 106, false, "round", "round");
    for (let i = 1; i < points.length - 1; i += 1) {
      const [x, y] = points[i];
      const dx = points[i + 1][0] - points[i - 1][0];
      const dy = points[i + 1][1] - points[i - 1][1];
      const length = Math.hypot(dx, dy);
      expect(covers(triangles, [x - (dy / length) * 52.5, y + (dx / length) * 52.5])).toBe(true);
    }
  });

  it("trims open paths by exact arc length", () => {
    expect(
      trimPolyline(
        [
          [0, 0],
          [10, 0],
          [10, 10],
        ],
        false,
        0.25,
        0.75,
      ),
    ).toEqual([
      {
        closed: false,
        points: [
          [5, 0],
          [10, 0],
          [10, 5],
        ],
      },
    ]);
  });

  it("joins wrapped trims across a closed path seam", () => {
    const trimmed = trimPolyline(
      [
        [0, 0],
        [10, 0],
        [10, 10],
        [0, 10],
      ],
      true,
      0.75,
      0.25,
    );
    expect(trimmed).toEqual([
      {
        closed: false,
        points: [
          [0, 10],
          [0, 0],
          [10, 0],
        ],
      },
    ]);
    expect(trimPolyline(trimmed[0].points, false, 0, 0)).toEqual([]);
  });
});

function covers(triangles: readonly [number, number][], point: [number, number]): boolean {
  const side = (a: [number, number], b: [number, number]) =>
    (b[0] - a[0]) * (point[1] - a[1]) - (b[1] - a[1]) * (point[0] - a[0]);
  for (let i = 0; i < triangles.length; i += 3) {
    const signs = [
      side(triangles[i], triangles[i + 1]),
      side(triangles[i + 1], triangles[i + 2]),
      side(triangles[i + 2], triangles[i]),
    ];
    if (signs.every((v) => v >= -1e-7) || signs.every((v) => v <= 1e-7)) return true;
  }
  return false;
}
