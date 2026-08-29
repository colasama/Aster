import { describe, expect, it, vi } from "vitest";
import {
  compositionToLocal,
  hitTestViewportTransform,
  localToComposition,
  moveAnchorPreservingGeometry,
  snapViewportPosition,
  ViewportPreviewCoalescer,
  type ViewportTransform2d,
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
});
