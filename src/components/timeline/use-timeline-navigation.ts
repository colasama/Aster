import { type RefObject, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { activeComposition } from "../../core/project/project";
import { useEditor } from "../../state/editor-store";
import { isEditableShortcutTarget } from "../../ui/keyboard-shortcuts";
import {
  TIMELINE_BASE_SCALE,
  TIMELINE_LABEL_WIDTH,
  timelineZoomBounds,
} from "../../ui/timeline-zoom";
import type { TimelineShortcut } from "./timeline-interactions";

export function useTimelineNavigation(
  scrollRef: RefObject<HTMLDivElement | null>,
  enabled: boolean,
) {
  const { state, dispatch } = useEditor();
  const composition = activeComposition(state.project);
  const frameDuration = composition.frameRate.denominator / composition.frameRate.numerator;
  const [viewport, setViewport] = useState({ width: 1000, scrollLeft: 0 });
  const pendingScroll = useRef<number | undefined>(undefined);
  const restoredView = useRef<{ zoom: number; scrollLeft: number } | undefined>(undefined);
  const bounds = timelineZoomBounds(
    composition.duration,
    frameDuration,
    viewport.width - TIMELINE_LABEL_WIDTH,
  );
  const pixelsPerSecond = state.timelineZoom * TIMELINE_BASE_SCALE;

  useLayoutEffect(() => {
    const scroll = scrollRef.current;
    if (!enabled || !scroll) return;
    const measure = () =>
      setViewport((previous) => {
        const width = scroll.clientWidth || previous.width;
        return width === previous.width && scroll.scrollLeft === previous.scrollLeft
          ? previous
          : { width, scrollLeft: scroll.scrollLeft };
      });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(scroll);
    scroll.addEventListener("scroll", measure);
    return () => {
      observer.disconnect();
      scroll.removeEventListener("scroll", measure);
    };
  }, [enabled, scrollRef]);

  useLayoutEffect(() => {
    if (scrollRef.current && pendingScroll.current !== undefined) {
      scrollRef.current.scrollLeft = pendingScroll.current;
      pendingScroll.current = undefined;
    }
  });

  // biome-ignore lint/correctness/useExhaustiveDependencies: Saved views belong to one composition.
  useEffect(() => {
    restoredView.current = undefined;
  }, [composition.id]);

  const zoomTo = useCallback(
    (requested: number, pointerX?: number, restoreScroll?: number) => {
      const scroll = scrollRef.current;
      if (!scroll) return;
      const zoom = Math.max(bounds.min, Math.min(bounds.max, requested));
      const visibleWidth = Math.max(1, viewport.width - TIMELINE_LABEL_WIDTH);
      const playheadX = state.currentTime * pixelsPerSecond - scroll.scrollLeft;
      const anchorX =
        pointerX === undefined
          ? playheadX >= 0 && playheadX <= visibleWidth
            ? playheadX
            : visibleWidth / 2
          : Math.max(0, pointerX - scroll.getBoundingClientRect().left - TIMELINE_LABEL_WIDTH);
      const time = (scroll.scrollLeft + anchorX) / pixelsPerSecond;
      pendingScroll.current =
        restoreScroll ?? Math.max(0, time * zoom * TIMELINE_BASE_SCALE - anchorX);
      if (zoom === state.timelineZoom) {
        scroll.scrollLeft = pendingScroll.current;
        pendingScroll.current = undefined;
      } else dispatch({ type: "setTimelineZoom", zoom });
    },
    [
      bounds.min,
      bounds.max,
      dispatch,
      pixelsPerSecond,
      scrollRef,
      state.currentTime,
      state.timelineZoom,
      viewport.width,
    ],
  );

  useEffect(() => {
    const scroll = scrollRef.current;
    if (!enabled || !scroll) return;
    const wheel = (event: WheelEvent) => {
      if (isEditableShortcutTarget(event.target)) return;
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? scroll.clientWidth : 1;
      if (event.altKey && !event.ctrlKey && !event.metaKey && event.deltaY !== 0) {
        event.preventDefault();
        zoomTo(
          state.timelineZoom *
            Math.exp(-Math.max(-300, Math.min(300, event.deltaY * unit)) * 0.002),
          event.clientX,
        );
      } else if (event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey) {
        event.preventDefault();
        scroll.scrollLeft += (event.deltaY || event.deltaX) * unit;
      }
    };
    scroll.addEventListener("wheel", wheel, { passive: false });
    return () => scroll.removeEventListener("wheel", wheel);
  }, [enabled, scrollRef, state.timelineZoom, zoomTo]);

  const handleShortcut = (shortcut: TimelineShortcut) => {
    const scroll = scrollRef.current;
    if (!scroll) return false;
    if (shortcut === "zoom-in" || shortcut === "zoom-out") {
      zoomTo(state.timelineZoom * (shortcut === "zoom-in" ? 1.25 : 1 / 1.25));
    } else if (shortcut === "zoom-frames") {
      const isFrames = Math.abs(state.timelineZoom - bounds.max) < 0.000001;
      zoomTo(
        isFrames ? bounds.min : bounds.max,
        undefined,
        isFrames
          ? 0
          : Math.max(
              0,
              state.currentTime * bounds.max * TIMELINE_BASE_SCALE -
                (viewport.width - TIMELINE_LABEL_WIDTH) / 2,
            ),
      );
    } else if (shortcut === "zoom-fit") {
      if (Math.abs(state.timelineZoom - bounds.min) < 0.000001 && restoredView.current) {
        const previous = restoredView.current;
        restoredView.current = undefined;
        zoomTo(previous.zoom, undefined, previous.scrollLeft);
      } else {
        restoredView.current = { zoom: state.timelineZoom, scrollLeft: scroll.scrollLeft };
        zoomTo(bounds.min, undefined, 0);
      }
    } else if (shortcut === "reveal-time") {
      scroll.scrollLeft = Math.max(
        0,
        state.currentTime * pixelsPerSecond - (viewport.width - TIMELINE_LABEL_WIDTH) / 2,
      );
    } else if (shortcut === "reveal-layer") {
      const row = scroll.querySelector<HTMLElement>(".timeline-layer.selected");
      if (row)
        scroll.scrollTop +=
          row.getBoundingClientRect().top - scroll.getBoundingClientRect().top - 26;
    } else return false;
    return true;
  };

  return { viewport, bounds, zoomTo, handleShortcut };
}
