import type { PointerEvent as ReactPointerEvent } from "react";
import {
  type EditableKeyframe,
  selectedKeyframes as findSelectedKeyframes,
  removeKeyframes,
  retimeKeyframes,
} from "../core/keyframe-editing";
import { activeComposition } from "../core/project";
import { snapTimelineTime } from "../core/timeline-editing";
import { useI18n } from "../i18n/react";
import { useEditor } from "../state/editor-store";
import { type buildTimelineSnapTargets, excludeTimelineSnapTargets } from "./timeline-interactions";
import type { KeyframeTimePreview } from "./timeline-property-tracks";
import type { StartWindowPointerDrag } from "./use-window-pointer-drag";

export type TimelineKeyframeEntry = EditableKeyframe & { label: string };

export function TimelineKeyframe({
  compositionDuration,
  disabled = false,
  entry,
  frameDuration,
  onPreview,
  pixelsPerSecond,
  preview,
  startPointerDrag,
  timelineTargets,
  variant = "overview",
}: {
  compositionDuration: number;
  disabled?: boolean;
  entry: TimelineKeyframeEntry;
  frameDuration: number;
  onPreview: (preview?: KeyframeTimePreview) => void;
  pixelsPerSecond: number;
  preview?: KeyframeTimePreview;
  startPointerDrag: StartWindowPointerDrag;
  timelineTargets: ReturnType<typeof buildTimelineSnapTargets>;
  variant?: "overview" | "property";
}) {
  const { state, dispatch } = useEditor();
  const { t } = useI18n();
  const displayTime = preview?.[entry.keyframe.id] ?? entry.keyframe.time;
  return (
    <button
      aria-label={t("keyframe.marker", {
        label: entry.label,
        time: displayTime.toFixed(2),
      })}
      className={`keyframe ${variant === "property" ? "property-keyframe" : ""} ${entry.source === "effect" ? "effect-key" : ""} ${state.selectedKeyframes.includes(entry.keyframe.id) ? "selected" : ""}`}
      disabled={disabled}
      onContextMenu={(event) => {
        event.preventDefault();
        if (disabled) return;
        const ids = state.selectedKeyframes.includes(entry.keyframe.id)
          ? state.selectedKeyframes
          : [entry.keyframe.id];
        const entries = findSelectedKeyframes(activeComposition(state.project), ids);
        dispatch({ type: "operation", operations: removeKeyframes(entries) });
        dispatch({ type: "selectKeyframes", ids: [] });
      }}
      onPointerDown={(event) =>
        startKeyframeDrag(event, {
          compositionDuration,
          disabled,
          dispatch,
          entry,
          frameDuration,
          onPreview,
          pixelsPerSecond,
          selectedKeyframeIds: state.selectedKeyframes,
          startPointerDrag,
          stateProject: state.project,
          timelineTargets,
        })
      }
      style={{ left: displayTime * pixelsPerSecond }}
      title={t("keyframe.dragHint", {
        label: entry.label,
        time: displayTime.toFixed(2),
        value: entry.keyframe.value.toFixed(2),
      })}
      type="button"
    >
      <span />
    </button>
  );
}

function startKeyframeDrag(
  event: ReactPointerEvent,
  context: {
    compositionDuration: number;
    disabled: boolean;
    dispatch: ReturnType<typeof useEditor>["dispatch"];
    entry: TimelineKeyframeEntry;
    frameDuration: number;
    onPreview: (preview?: KeyframeTimePreview) => void;
    pixelsPerSecond: number;
    selectedKeyframeIds: string[];
    startPointerDrag: StartWindowPointerDrag;
    stateProject: ReturnType<typeof useEditor>["state"]["project"];
    timelineTargets: ReturnType<typeof buildTimelineSnapTargets>;
  },
) {
  if (event.button !== 0 || context.disabled) return;
  event.stopPropagation();
  const additive = event.shiftKey;
  const alreadySelected = context.selectedKeyframeIds.includes(context.entry.keyframe.id);
  const selectedIds = additive
    ? alreadySelected
      ? context.selectedKeyframeIds.filter((id) => id !== context.entry.keyframe.id)
      : [...context.selectedKeyframeIds, context.entry.keyframe.id]
    : alreadySelected
      ? context.selectedKeyframeIds
      : [context.entry.keyframe.id];
  context.dispatch({ type: "selectKeyframes", ids: selectedIds });
  const selectedEntries = findSelectedKeyframes(
    activeComposition(context.stateProject),
    selectedIds,
  );
  const dragTargets = excludeTimelineSnapTargets(context.timelineTargets, selectedIds);
  const startX = event.clientX;
  const initialTime = context.entry.keyframe.time;
  let nextTime = initialTime;
  let dragged = false;
  let operations = retimeKeyframes(
    selectedEntries,
    context.entry.keyframe.id,
    initialTime,
    context.frameDuration,
    event.altKey,
    false,
    context.compositionDuration,
  );
  context.startPointerDrag(event.pointerId, {
    onMove: (moveEvent) => {
      if (Math.abs(moveEvent.clientX - startX) >= 2) dragged = true;
      const requestedTime = Math.max(
        0,
        Math.min(
          context.compositionDuration,
          initialTime + (moveEvent.clientX - startX) / context.pixelsPerSecond,
        ),
      );
      nextTime = snapTimelineTime(
        requestedTime,
        context.frameDuration,
        context.pixelsPerSecond,
        dragTargets,
        moveEvent.ctrlKey || moveEvent.metaKey,
      ).time;
      operations = retimeKeyframes(
        selectedEntries,
        context.entry.keyframe.id,
        nextTime,
        context.frameDuration,
        moveEvent.altKey,
        false,
        context.compositionDuration,
      );
      if (dragged) context.onPreview(keyframePreviewFromOperations(operations));
    },
    onCommit: () => {
      context.onPreview(undefined);
      if (!dragged) {
        context.dispatch({ type: "setTime", time: initialTime });
        return;
      }
      if (Math.abs(nextTime - initialTime) < 0.001 || !operations.length) return;
      context.dispatch({ type: "operation", operations });
    },
    onCancel: () => context.onPreview(undefined),
  });
}

export function keyframePreviewFromOperations(
  operations: ReturnType<typeof retimeKeyframes>,
): KeyframeTimePreview {
  return Object.fromEntries(operations.map((operation) => [operation.keyframeId, operation.time]));
}
