import { describe, expect, it } from "vitest";
import { createInitialState, editorReducer } from "../../state/editor-store";
import { applyOperations, getProperty } from "../editing/operations";
import { propertyValueOperationAtTime } from "../editing/property-edit-operation";
import { createLayerForComposition } from "../layers/layer-factory";
import { createBlankProject } from "../project/project";
import { staticValue } from "../types";
import {
  collectEditableKeyframes,
  copyKeyframes,
  pasteKeyframes,
  removeKeyframes,
} from "./keyframe-editing";
import { textAnimatorPropertyPath, textSelectorPropertyPath } from "./text-animator-property-paths";

describe("text animator property operations", () => {
  it("edits animator and selector tracks at current time with stable keyframe identity", () => {
    const project = createBlankProject();
    const composition = project.compositions[0];
    const layer = createLayerForComposition("text", composition);
    composition.layers.push(layer);
    const animator = layer.textAnimator?.groups[0];
    const selector = animator?.selectors[0];
    if (!animator || !selector) throw new Error("Expected text animator");
    animator.properties.opacity = staticValue(100);
    const opacityPath = textAnimatorPropertyPath(animator.id, "opacity");
    const amountPath = textSelectorPropertyPath(animator.id, selector.id, "amount");

    const keyed = applyOperations(project, [
      {
        type: "addKeyframe",
        layerId: layer.id,
        path: opacityPath,
        keyframe: { id: "opacity-start", time: 0, value: 100, interpolation: "linear" },
      },
      {
        type: "addKeyframe",
        layerId: layer.id,
        path: opacityPath,
        keyframe: { id: "opacity-end", time: 2, value: 0, interpolation: "linear" },
      },
      {
        type: "addKeyframe",
        layerId: layer.id,
        path: amountPath,
        keyframe: { id: "amount-start", time: 0, value: 0, interpolation: "linear" },
      },
    ]);
    const keyedLayer = keyed.compositions[0].layers.find((candidate) => candidate.id === layer.id);
    if (!keyedLayer) throw new Error("Expected keyed layer");
    const edit = propertyValueOperationAtTime(keyedLayer, opacityPath, 35, 1, "opacity-middle");
    const edited = applyOperations(keyed, [edit]);
    const editedLayer = edited.compositions[0].layers.find(
      (candidate) => candidate.id === layer.id,
    );
    if (!editedLayer) throw new Error("Expected edited layer");
    expect(getProperty(editedLayer, opacityPath)).toMatchObject({
      mode: "animated",
      keyframes: [
        { id: "opacity-start", time: 0, value: 100 },
        { id: "opacity-middle", time: 1, value: 35 },
        { id: "opacity-end", time: 2, value: 0 },
      ],
    });

    const updated = applyOperations(edited, [
      {
        type: "updateKeyframe",
        layerId: layer.id,
        path: opacityPath,
        keyframeId: "opacity-middle",
        time: 1.25,
        value: 150,
        interpolation: "bezier",
        easing: [0.25, 0, 0.75, 1],
      },
    ]);
    const updatedLayer = updated.compositions[0].layers.find(
      (candidate) => candidate.id === layer.id,
    );
    if (!updatedLayer) throw new Error("Expected updated layer");
    const updatedProperty = getProperty(updatedLayer, opacityPath);
    expect(updatedProperty.mode).toBe("animated");
    expect(
      updatedProperty.mode === "animated"
        ? updatedProperty.keyframes.find((keyframe) => keyframe.id === "opacity-middle")
        : undefined,
    ).toMatchObject({
      id: "opacity-middle",
      time: 1.25,
      value: 100,
      interpolation: "bezier",
    });
  });

  it("copies, pastes and removes text keys through one undoable operation transaction", () => {
    const project = createBlankProject();
    const composition = project.compositions[0];
    const layer = createLayerForComposition("text", composition);
    composition.layers.push(layer);
    const animator = layer.textAnimator?.groups[0];
    if (!animator) throw new Error("Expected text animator");
    const path = textAnimatorPropertyPath(animator.id, "position", 0);
    const keyed = applyOperations(project, [
      {
        type: "addKeyframe",
        layerId: layer.id,
        path,
        keyframe: { id: "text-position", time: 1, value: 40, interpolation: "linear" },
      },
    ]);
    const entries = collectEditableKeyframes(keyed.compositions[0]).filter(
      (entry) => entry.source === "transform" && entry.path === path,
    );
    expect(entries).toHaveLength(1);
    const clipboard = copyKeyframes(entries);
    if (!clipboard) throw new Error("Expected clipboard");
    const pasted = pasteKeyframes(clipboard, 3, composition.duration);
    expect(pasted.operations).toMatchObject([{ type: "addKeyframe", path }]);

    const initial = {
      ...createInitialState(),
      project: keyed,
      selection: [layer.id],
      history: { past: [], future: [] },
    };
    const committed = editorReducer(initial, {
      type: "operation",
      operations: [...pasted.operations, ...removeKeyframes(entries)],
    });
    expect(committed.history.past).toHaveLength(1);
    const committedLayer = committed.project.compositions[0].layers.find(
      (candidate) => candidate.id === layer.id,
    );
    const committedProperty = committedLayer && getProperty(committedLayer, path);
    expect(
      committedProperty?.mode === "animated"
        ? committedProperty.keyframes.map(({ id, time }) => ({ id, time }))
        : [],
    ).toEqual([{ id: pasted.selectedIds[0], time: 3 }]);

    const undone = editorReducer(committed, { type: "undo" });
    const undoneLayer = undone.project.compositions[0].layers.find(
      (candidate) => candidate.id === layer.id,
    );
    expect(undoneLayer && getProperty(undoneLayer, path)).toMatchObject({
      mode: "animated",
      keyframes: [{ id: "text-position", time: 1 }],
    });
    const redone = editorReducer(undone, { type: "redo" });
    const redoneLayer = redone.project.compositions[0].layers.find(
      (candidate) => candidate.id === layer.id,
    );
    expect(redoneLayer && getProperty(redoneLayer, path)).toMatchObject({
      mode: "animated",
      keyframes: [{ id: pasted.selectedIds[0], time: 3 }],
    });
  });
});
