import { useEffect, useRef } from "react";
import { getProperty, type Operation } from "../../core/editing/operations";
import { activeComposition } from "../../core/project/project";
import type { Project } from "../../core/types";
import { useEditor } from "../../state/editor-store";
import type { NumericEditPhase } from "../NumericInput";

type PropertyEdit = Extract<
  Operation,
  { type: "setProperty" | "addKeyframe" | "setEffectParameterAtTime" }
>;

/** Restore the original track, including the absence of a keyframe at the edit time. */
function restoreProperty(project: Project, operation: PropertyEdit): Operation[] {
  const layer = activeComposition(project).layers.find((entry) => entry.id === operation.layerId);
  if (!layer) return [];
  if (operation.type === "setEffectParameterAtTime") {
    const effect = layer.effects.find((entry) => entry.id === operation.effectId);
    if (!effect) return [];
    const track = effect.parameterKeyframes?.[operation.parameter];
    const keyframe = track?.find((entry) => Math.abs(entry.time - operation.time) <= 0.000_001);
    const target = { layerId: layer.id, effectId: effect.id, parameter: operation.parameter };
    if (keyframe) return [{ type: "addEffectParameterKeyframe", ...target, keyframe }];
    if (track?.length)
      return [
        { type: "removeEffectParameterKeyframe", ...target, keyframeId: operation.keyframeId },
      ];
    return [
      { type: "setEffectParameter", ...target, value: effect.parameters[operation.parameter] },
    ];
  }
  const property = getProperty(layer, operation.path);
  if (property.mode === "static")
    return [
      { type: "setProperty", layerId: layer.id, path: operation.path, value: property.value },
    ];
  if (operation.type !== "addKeyframe") return [];
  const keyframe = property.keyframes.find(
    (entry) => Math.abs(entry.time - operation.keyframe.time) <= 0.000_001,
  );
  return keyframe
    ? [{ ...operation, keyframe }]
    : [
        {
          type: "removeKeyframe",
          layerId: layer.id,
          path: operation.path,
          keyframeId: operation.keyframe.id,
        },
      ];
}

export function useInspectorPropertyEdit() {
  const { state, dispatch } = useEditor();
  const transaction = useRef<
    { base: Project; rollback: Operation[]; operation: PropertyEdit } | undefined
  >(undefined);
  const currentProject = useRef(state.project);
  currentProject.current = state.project;
  const cancel = () => {
    const current = transaction.current;
    transaction.current = undefined;
    if (
      current &&
      current.base.id === currentProject.current.id &&
      current.base.activeCompositionId === currentProject.current.activeCompositionId
    ) {
      dispatch({ type: "previewOperation", operations: current.rollback });
    }
  };
  const cancelRef = useRef(cancel);
  cancelRef.current = cancel;
  useEffect(() => () => cancelRef.current(), []);

  return (operation: Operation, phase: NumericEditPhase = "commit") => {
    if (phase === "cancel") return cancel();
    if (
      operation.type !== "setProperty" &&
      operation.type !== "addKeyframe" &&
      operation.type !== "setEffectParameterAtTime"
    )
      return;
    const first = transaction.current?.operation;
    if (first?.type === "addKeyframe" && operation.type === "addKeyframe") {
      operation = { ...operation, keyframe: { ...operation.keyframe, id: first.keyframe.id } };
    } else if (
      first?.type === "setEffectParameterAtTime" &&
      operation.type === "setEffectParameterAtTime"
    ) {
      operation = { ...operation, keyframeId: first.keyframeId };
    }
    if (phase === "preview") {
      transaction.current ??= {
        base: state.project,
        operation,
        rollback: restoreProperty(state.project, operation),
      };
      dispatch({ type: "previewOperation", operations: [operation] });
    } else {
      const base = transaction.current?.base;
      transaction.current = undefined;
      dispatch({ type: "operation", operations: [operation], historyBase: base });
    }
  };
}
