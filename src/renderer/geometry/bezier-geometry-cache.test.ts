import { describe, expect, it } from "vitest";
import { createLayerForComposition } from "../../core/layers/layer-factory";
import { createBlankProject } from "../../core/project/project";
import type { BezierPath, ShapeSettings } from "../../core/types";
import { cachedBezierGeometry } from "./bezier-geometry-cache";

function fixture(): { path: BezierPath; shape: ShapeSettings } {
  const composition = createBlankProject().compositions[0];
  const shape = createLayerForComposition("shape", composition).shape as ShapeSettings;
  shape.strokeWidth = 4;
  shape.lineCap = "butt";
  const path: BezierPath = {
    closed: false,
    vertices: [
      { position: [-0.5, 0], inTangent: [0, 0], outTangent: [0, 0] },
      { position: [0.5, 0], inTangent: [0, 0], outTangent: [0, 0] },
      { position: [0, 0.5], inTangent: [0, 0], outTangent: [0, 0] },
    ],
  };
  return { path, shape };
}

describe("persistent Bezier geometry", () => {
  it("shares identical local geometry across copies and paint changes", () => {
    const { path, shape } = fixture();
    const first = cachedBezierGeometry(path, shape, 100, 100);
    shape.strokeColor = [1, 0, 0, 0.5];
    shape.gradientAngle = 45;
    expect(cachedBezierGeometry(structuredClone(path), shape, 100, 100)).toBe(first);
    expect(first.fill).toHaveLength(0);
    expect(first.stroke.length).toBeGreaterThan(0);
  });

  it("invalidates control-point edits and topology changes made in place", () => {
    const { path, shape } = fixture();
    const first = cachedBezierGeometry(path, shape, 100, 100);
    path.vertices[0].position[0] = -0.75;
    const edited = cachedBezierGeometry(path, shape, 100, 100);
    expect(edited.stroke).not.toEqual(first.stroke);
    path.closed = true;
    const closed = cachedBezierGeometry(path, shape, 100, 100);
    expect(closed.fill).toHaveLength(3);
    expect(closed.fill).toContainEqual([-0.75, 0]);
    path.vertices[0].outTangent = [0.25, -0.25];
    expect(cachedBezierGeometry(path, shape, 100, 100).fill).not.toEqual(closed.fill);
  });

  it("keeps fractional and mirrored stroke dimensions distinct", () => {
    const { path, shape } = fixture();
    const first = cachedBezierGeometry(path, shape, 100.1, 100.1);
    for (const [width, height] of [
      [100.2, 100.1],
      [100.1, 100.2],
      [-100.1, 100.1],
      [100.1, -100.1],
    ]) {
      expect(cachedBezierGeometry(path, shape, width, height).stroke).not.toEqual(first.stroke);
    }
    shape.strokeWidth = 0;
    const fillOnly = cachedBezierGeometry(path, shape, 100.1, 100.1);
    expect(cachedBezierGeometry(path, shape, 250, -120)).toBe(fillOnly);
  });

  it("rebuilds strokes when width, trim, caps or joins change", () => {
    const { path, shape } = fixture();
    let previous = cachedBezierGeometry(path, shape, 100, 100);
    for (const edit of [
      () => {
        shape.strokeWidth = 8;
      },
      () => {
        shape.trim = { start: 10, end: 90, offset: 0 };
      },
      () => {
        shape.trim = { start: 10, end: 90, offset: 10 };
      },
      () => {
        shape.lineCap = "round";
      },
      () => {
        shape.lineJoin = "bevel";
      },
    ]) {
      edit();
      const next = cachedBezierGeometry(path, shape, 100, 100);
      expect(next.stroke).not.toEqual(previous.stroke);
      previous = next;
    }
  });

  it("evicts old entries instead of retaining every animated path", () => {
    const { path, shape } = fixture();
    path.vertices[0].position[0] = -10;
    const first = cachedBezierGeometry(path, shape, 123, 456);
    for (let index = 0; index < 128; index++) {
      const animated = structuredClone(path);
      animated.vertices[0].position[0] = -20 - index;
      cachedBezierGeometry(animated, shape, 123, 456);
    }
    const rebuilt = cachedBezierGeometry(path, shape, 123, 456);
    expect(rebuilt).not.toBe(first);
    expect(rebuilt).toEqual(first);
  });
});
