import { describe, expect, it, vi } from "vitest";
import {
  compositionToLocal,
  hitTestViewportTransform,
  localToComposition,
  moveAnchorPreservingGeometry,
  moveViewportSelection,
  resizeViewportSelection,
  resizeViewportTransform,
  rotateViewportSelectionFromPointer,
  rotateViewportTransformFromPointer,
  snapViewportPosition,
  ViewportPreviewCoalescer,
  type ViewportTransform2d,
  viewportSelectionBounds,
  viewportSnapTargets,
  viewportTransformBounds,
} from "./transform-interaction";

const transform: ViewportTransform2d = {
  position: [400, 300],
  scale: [150, 75],
  rotation: 30,
  anchor: [100, 50],
  size: [200, 100],
};

describe("viewport transform interaction", () => {
  it("roundtrips points through rotation, nonuniform scale, and anchor", () => {
    const point = [40, 75] as const;
    expect(compositionToLocal(localToComposition(point, transform), transform)).toEqual(
      expect.arrayContaining([expect.closeTo(point[0], 8), expect.closeTo(point[1], 8)]),
    );
    expect(hitTestViewportTransform(localToComposition(point, transform), transform)).toBe(true);
    expect(hitTestViewportTransform([0, 0], transform)).toBe(false);
  });

  it("moves an anchor without changing rendered geometry", () => {
    const before = localToComposition([20, 30], transform);
    const moved = moveAnchorPreservingGeometry(transform, [150, 20]);
    expect(localToComposition([20, 30], moved)).toEqual(
      expect.arrayContaining([expect.closeTo(before[0], 8), expect.closeTo(before[1], 8)]),
    );
  });

  it("computes rotated bounds and snaps in screen-space tolerance", () => {
    const simple: ViewportTransform2d = {
      position: [390, 300],
      scale: [100, 100],
      rotation: 0,
      anchor: [50, 50],
      size: [100, 100],
    };
    expect(viewportTransformBounds(simple)).toEqual({
      left: 340,
      top: 250,
      right: 440,
      bottom: 350,
    });
    const targets = viewportSnapTargets([800, 600]);
    const snapped = snapViewportPosition([393, 300], simple, targets, 8, 1);
    expect(snapped.position).toEqual([400, 300]);
    expect(snapped.snapped.map((target) => target.id)).toEqual([
      "composition-center-x",
      "composition-center-y",
    ]);
    expect(snapViewportPosition([393, 300], simple, targets, 8, 2).position[0]).toBe(393);
  });

  it("resizes in rotated local axes while preserving the opposite edge", () => {
    const simple: ViewportTransform2d = {
      position: [300, 200],
      scale: [100, 100],
      rotation: 30,
      anchor: [50, 50],
      size: [100, 100],
    };
    const fixed = localToComposition([0, 50], simple);
    const pointer = localToComposition([200, 50], { ...simple, scale: [100, 100] });
    const resized = resizeViewportTransform(simple, "east", pointer);
    expect(resized.scale).toEqual(expect.arrayContaining([expect.closeTo(200, 8), 100]));
    expect(localToComposition([0, 50], resized)).toEqual(
      expect.arrayContaining([expect.closeTo(fixed[0], 8), expect.closeTo(fixed[1], 8)]),
    );
  });

  it("supports proportional, anchor-centered, and mirrored scaling without geometry drift", () => {
    const simple: ViewportTransform2d = {
      position: [300, 200],
      scale: [100, 50],
      rotation: -20,
      anchor: [50, 50],
      size: [100, 100],
    };
    const fixed = localToComposition([0, 0], simple);
    const target = localToComposition([200, 150], { ...simple, scale: [100, 100] });
    const proportional = resizeViewportTransform(simple, "southEast", target, {
      preserveAspectRatio: true,
    });
    expect(proportional.scale[0] / simple.scale[0]).toBeCloseTo(
      proportional.scale[1] / simple.scale[1],
    );
    expect(localToComposition([0, 0], proportional)).toEqual(
      expect.arrayContaining([expect.closeTo(fixed[0], 8), expect.closeTo(fixed[1], 8)]),
    );
    const anchorBefore = localToComposition(simple.anchor, simple);
    const anchorScaled = resizeViewportTransform(
      simple,
      "southEast",
      localToComposition([150, 150], simple),
      { fromAnchor: true },
    );
    expect(localToComposition(simple.anchor, anchorScaled)).toEqual(anchorBefore);
    const mirrored = resizeViewportTransform(simple, "east", localToComposition([-50, 50], simple));
    expect(mirrored.scale[0]).toBeLessThan(0);
  });

  it("rotates around the rendered anchor with optional angle snapping", () => {
    const simple: ViewportTransform2d = {
      position: [100, 100],
      scale: [100, 100],
      rotation: 5,
      anchor: [50, 50],
      size: [100, 100],
    };
    expect(rotateViewportTransformFromPointer(simple, [200, 100], [100, 200]).rotation).toBeCloseTo(
      95,
    );
    expect(rotateViewportTransformFromPointer(simple, [200, 100], [100, 200], 15).rotation).toBe(
      90,
    );
  });

  it("coalesces pointer previews and flushes the final value", () => {
    const callbacks = new Map<number, FrameRequestCallback>();
    let nextHandle = 1;
    const publish = vi.fn();
    const coalescer = new ViewportPreviewCoalescer(
      publish,
      (callback) => {
        const handle = nextHandle;
        nextHandle += 1;
        callbacks.set(handle, callback);
        return handle;
      },
      (handle) => callbacks.delete(handle),
    );
    coalescer.update(1);
    coalescer.update(2);
    expect(callbacks.size).toBe(1);
    const callback = callbacks.get(1);
    callbacks.delete(1);
    callback?.(0);
    expect(publish).toHaveBeenLastCalledWith(2);
    coalescer.update(3);
    coalescer.flush();
    expect(publish).toHaveBeenLastCalledWith(3);
    expect(callbacks.size).toBe(0);
  });

  it("moves, snaps, resizes, and rotates multi-selection bounds as one rigid group", () => {
    const members = [
      {
        id: "a",
        transform: {
          position: [100, 100] as const,
          scale: [100, 100] as const,
          rotation: 0,
          anchor: [50, 50] as const,
          size: [100, 100] as const,
        },
      },
      {
        id: "b",
        transform: {
          position: [300, 100] as const,
          scale: [100, 100] as const,
          rotation: 0,
          anchor: [50, 50] as const,
          size: [100, 100] as const,
        },
      },
    ];
    expect(viewportSelectionBounds(members)).toEqual({
      left: 50,
      top: 50,
      right: 350,
      bottom: 150,
    });
    const moved = moveViewportSelection(members, [45, 0], viewportSnapTargets([800, 600]), 6, 1);
    expect(moved.members.map((member) => member.transform.position[0])).toEqual([150, 350]);
    expect(moved.snapped.map((target) => target.id)).toContain("composition-center-x");

    const resized = resizeViewportSelection(members, "east", [500, 100]);
    expect(resized[0]?.transform.position[0]).toBeCloseTo(125, 5);
    expect(resized[1]?.transform.position[0]).toBeCloseTo(425, 5);
    expect(resized[0]?.transform.scale[0]).toBeCloseTo(150, 5);
    const rotated = rotateViewportSelectionFromPointer(members, [200, 0], [300, 100], 15);
    expect(rotated[0]?.transform.position).toEqual([200, 0]);
    expect(rotated[1]?.transform.position).toEqual([200, 200]);
    expect(rotated.map((member) => member.transform.rotation)).toEqual([90, 90]);
  });
});
