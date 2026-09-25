import {
  type KeyboardEvent,
  type MouseEvent,
  memo,
  type PointerEvent,
  type RefObject,
  useCallback,
  useRef,
} from "react";
import type { Composition, Layer } from "../../core/types";
import { useEditorDocument } from "../../state/editor-store";
import type { StartWindowPointerDrag } from "../use-window-pointer-drag";
import { TimelineLayerRow } from "./TimelineLayerRow";
import type { buildTimelineSnapTargets, LayerTimingDrag } from "./timeline-interactions";
import type { KeyframeTimePreview } from "./timeline-property-tracks";
import { useTimelineRowObserver } from "./use-timeline-row-window";

export interface TimelineLayerActions {
  marquee(event: PointerEvent, row: number): void;
  timing(event: PointerEvent, layer: Layer, mode: LayerTimingDrag): void;
  menu(event: MouseEvent<HTMLDivElement>, layer: Layer): void;
  menuKey(event: KeyboardEvent<HTMLDivElement>, layer: Layer): void;
}

/** Keep the stationary row tree out of clock/profiler renders; gestures read current inputs. */
export const TimelineLayers = memo(function TimelineLayers({
  composition,
  keyframeTimePreview,
  timingPreview,
  onKeyframeTimePreview,
  startPointerDrag,
  actions,
  targets,
}: {
  composition: Composition;
  keyframeTimePreview?: KeyframeTimePreview;
  timingPreview?: Record<string, { inPoint: number; outPoint: number }>;
  onKeyframeTimePreview(preview?: KeyframeTimePreview): void;
  startPointerDrag: StartWindowPointerDrag;
  actions: RefObject<TimelineLayerActions>;
  targets: RefObject<ReturnType<typeof buildTimelineSnapTargets>>;
}) {
  const { state, dispatch } = useEditorDocument();
  const rowsRef = useRef<HTMLDivElement>(null);
  const observeRow = useTimelineRowObserver(rowsRef);
  const dragLayer = useRef<string | undefined>(undefined);
  const getTargets = useCallback(() => targets.current, [targets]);
  return (
    <div className="layer-rows" ref={rowsRef}>
      {composition.layers.map((layer, index) => (
        <TimelineLayerRow
          composition={composition}
          index={index}
          keyframeTimePreview={keyframeTimePreview}
          key={layer.id}
          layer={layer}
          observeRow={observeRow}
          onDragStart={() => {
            dragLayer.current = layer.id;
          }}
          onDragEnd={() => {
            dragLayer.current = undefined;
          }}
          onDrop={() => {
            if (dragLayer.current && dragLayer.current !== layer.id)
              dispatch({
                type: "operation",
                operations: [{ type: "reorderLayer", layerId: dragLayer.current, index }],
              });
            dragLayer.current = undefined;
          }}
          onKeyframeTimePreview={onKeyframeTimePreview}
          onContextMenu={(event) => actions.current.menu(event, layer)}
          onContextMenuKeyDown={(event) => actions.current.menuKey(event, layer)}
          onMarqueeStart={(event) => actions.current.marquee(event, index)}
          onTimingDragStart={(event, mode) => actions.current.timing(event, layer, mode)}
          selected={state.selection.includes(layer.id)}
          startPointerDrag={startPointerDrag}
          timing={timingPreview?.[layer.id]}
          timelineTargets={getTargets}
        />
      ))}
    </div>
  );
});
