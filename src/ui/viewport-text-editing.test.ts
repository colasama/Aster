import { describe, expect, it } from "vitest";
import { createLayerForComposition } from "../core/layer-factory";
import { activeComposition, createBlankComposition, createBlankProject } from "../core/project";
import { createInitialState, editorReducer } from "../state/editor-store";
import {
  beginViewportTextEdit,
  canEditViewportText,
  commitViewportTextEdit,
  previewViewportTextEdit,
  updateViewportTextEdit,
} from "./viewport-text-editing";

describe("viewport text edit transaction", () => {
  it("renders an immutable live draft and commits the whole edit as one undo step", () => {
    const project = createBlankProject();
    const composition = activeComposition(project);
    const layer = createLayerForComposition("text", composition);
    layer.text = "Original";
    layer.effects = [
      { id: "fx", type: "glow", name: "Glow", enabled: true, parameters: { radius: 24 } },
    ];
    composition.layers = [layer];
    const untouchedComposition = createBlankComposition();
    project.compositions.push(untouchedComposition);
    const originalStyle = structuredClone(layer.textStyle);
    const originalAnimator = structuredClone(layer.textAnimator);
    const session = beginViewportTextEdit(project, composition, layer.id, 0);
    if (!session) throw new Error("Expected editable text session");
    const draft = updateViewportTextEdit(session, "GPU live draft");
    const preview = previewViewportTextEdit(project, composition, 0, draft);

    expect(activeComposition(project).layers[0].text).toBe("Original");
    expect(preview.compositions[1]).toBe(untouchedComposition);
    expect(activeComposition(preview).layers[0]).toMatchObject({
      text: "GPU live draft",
      effects: layer.effects,
      textAnimator: originalAnimator,
      textStyle: originalStyle,
    });

    const initial = {
      ...createInitialState(),
      project,
      selection: [layer.id],
      history: { past: [], future: [] },
    };
    const transaction = commitViewportTextEdit(draft);
    if (!transaction) throw new Error("Expected changed text transaction");
    const committed = editorReducer(initial, {
      type: "operation",
      historyBase: transaction.historyBase,
      operations: [...transaction.operations],
    });
    expect(committed.history.past).toHaveLength(1);
    expect(activeComposition(committed.project).layers[0].text).toBe("GPU live draft");
    expect(
      activeComposition(editorReducer(committed, { type: "undo" }).project).layers[0].text,
    ).toBe("Original");
    expect(
      previewViewportTextEdit(committed.project, activeComposition(committed.project), 0, draft),
    ).toBe(committed.project);
  });

  it("rolls back by dropping the draft and rejects locked, hidden, and inactive layers", () => {
    const project = createBlankProject();
    const composition = activeComposition(project);
    const layer = createLayerForComposition("text", composition);
    layer.text = "Original";
    composition.layers = [layer];
    const session = beginViewportTextEdit(project, composition, layer.id, 0);
    if (!session) throw new Error("Expected editable text session");
    const draft = updateViewportTextEdit(session, "Discard me");
    expect(
      activeComposition(previewViewportTextEdit(project, composition, 0, draft)).layers[0].text,
    ).toBe("Discard me");
    expect(previewViewportTextEdit(project, composition, 0, undefined)).toBe(project);
    expect(activeComposition(project).layers[0].text).toBe("Original");

    layer.locked = true;
    expect(canEditViewportText(composition, layer.id, 0)).toBe(false);
    expect(previewViewportTextEdit(project, composition, 0, draft)).toBe(project);
    layer.locked = false;
    layer.visible = false;
    expect(canEditViewportText(composition, layer.id, 0)).toBe(false);
    layer.visible = true;
    layer.inPoint = 1;
    expect(canEditViewportText(composition, layer.id, 0)).toBe(false);
  });
});
