import { describe, expect, it } from "vitest";
import { evaluateAnimatable } from "../../core/animation/timeline";
import { activeComposition } from "../../core/project/project";
import { createInitialState, editorReducer } from "../../state/editor-store";
import { clampScale, rotateViewportPoint, safeScaleRatio, viewportCssMatrix } from "./Viewport";

describe("viewport direct manipulation", () => {
  it("keeps live previews out of undo history and commits from the gesture start", () => {
    const initial = createInitialState();
    const layer = activeComposition(initial.project).layers[0];
    const original = evaluateAnimatable(layer.transform.position[0], initial.currentTime);
    const preview = editorReducer(initial, {
      type: "previewOperation",
      operations: [
        { type: "setProperty", layerId: layer.id, path: "position.0", value: original + 50 },
      ],
    });

    expect(preview.history.past).toHaveLength(0);
    expect(
      evaluateAnimatable(
        activeComposition(preview.project).layers[0].transform.position[0],
        preview.currentTime,
      ),
    ).toBe(original + 50);

    const committed = editorReducer(preview, {
      type: "operation",
      historyBase: initial.project,
      operations: [
        { type: "setProperty", layerId: layer.id, path: "position.0", value: original + 80 },
      ],
    });
    const undone = editorReducer(committed, { type: "undo" });

    expect(committed.history.past).toHaveLength(1);
    expect(
      evaluateAnimatable(
        activeComposition(undone.project).layers[0].transform.position[0],
        undone.currentTime,
      ),
    ).toBe(original);
  });

  it("evaluates rotated scale gestures with bounded ratios", () => {
    const rotated = rotateViewportPoint(0, 10, -90);
    expect(rotated[0]).toBeCloseTo(10);
    expect(rotated[1]).toBeCloseTo(0);
    expect(safeScaleRatio(20, 10)).toBe(2);
    expect(safeScaleRatio(20, 0)).toBe(1);
    expect(clampScale(0)).toBe(0.1);
    expect(clampScale(-20_000)).toBe(-10_000);
  });

  it("maps text editing overlays through the same anchor, rotation, flip, and zoom matrix", () => {
    expect(
      viewportCssMatrix(
        {
          position: [400, 300, 0],
          rotation: [0, 0, 0],
          scale: [-100, 50, 100],
          anchor: [100, 50, 0],
        },
        0.5,
      ),
    ).toBe("matrix(-1, 0, 0, 0.5, 250, 137.5)");
  });
});
