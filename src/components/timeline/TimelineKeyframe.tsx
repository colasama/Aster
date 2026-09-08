import type { PointerEvent as ReactPointerEvent } from "react";
import {
  type EditableKeyframe,
  selectedKeyframes as findSelectedKeyframes,
  retimeKeyframes,
} from "../../core/animation/keyframe-editing";
import { snapTimelineTime } from "../../core/animation/timeline-editing";
import { activeComposition } from "../../core/project/project";
import { useI18n } from "../../i18n/react";
import { useEditorDocument } from "../../state/editor-store";
import type { StartWindowPointerDrag } from "../use-window-pointer-drag";
import { excludeTimelineSnapTargets, type TimelineSnapTargets } from "./timeline-interactions";
import type { KeyframeTimePreview } from "./timeline-property-tracks";

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
  timelineTargets: TimelineSnapTargets;
  variant?: "overview" | "property";
}) {
  const { state, dispatch } = useEditorDocument();
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
      onContextMenu={() => {
        if (disabled) return;
        if (!state.selectedKeyframes.includes(entry.keyframe.id))
          dispatch({ type: "selectKeyframes", ids: [entry.keyframe.id] });
      }}
      onKeyDown={(event) => {
        if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) return;
        event.preventDefault();
        if (!state.selectedKeyframes.includes(entry.keyframe.id))
          dispatch({ type: "selectKeyframes", ids: [entry.keyframe.id] });
        const bounds = event.currentTarget.getBoundingClientRect();
        event.currentTarget.dispatchEvent(
          new MouseEvent("contextmenu", {
            bubbles: true,
            cancelable: true,
            clientX: bounds.left + Math.min(12, bounds.width),
            clientY: bounds.bottom,
          }),
        );
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
    dispatch: ReturnType<typeof useEditorDocument>["dispatch"];
    entry: TimelineKeyframeEntry;
    frameDuration: number;
    onPreview: (preview?: KeyframeTimePreview) => void;
    pixelsPerSecond: number;
    selectedKeyframeIds: string[];
    startPointerDrag: StartWindowPointerDrag;
    stateProject: ReturnType<typeof useEditorDocument>["state"]["project"];
    timelineTargets: TimelineSnapTargets;
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
  const dragTargets = excludeTimelineSnapTargets(
    typeof context.timelineTargets === "function"
      ? context.timelineTargets()
      : context.timelineTargets,
    selectedIds,
  );
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
