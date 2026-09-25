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
import { timelinePixelsPerSecond, timelineZoomStore } from "./timeline-zoom-store";

export function useTimelineNavigation(
  scrollRef: RefObject<HTMLDivElement | null>,
  enabled: boolean,
) {
  const { state } = useEditor();
  const composition = activeComposition(state.project);
  const frameDuration = composition.frameRate.denominator / composition.frameRate.numerator;
  const [viewport, setViewport] = useState({ width: 1000, scrollLeft: 0 });
  const pendingScroll = useRef<number | undefined>(undefined);
  const restoredView = useRef<{ zoom: number; scrollLeft: number } | undefined>(undefined);
  const viewportWidth = useRef(viewport.width);
  viewportWidth.current = viewport.width;
  const currentTime = useRef(state.currentTime);
  currentTime.current = state.currentTime;
  const bounds = timelineZoomBounds(
    composition.duration,
    frameDuration,
    viewport.width - TIMELINE_LABEL_WIDTH,
  );

  useLayoutEffect(() => {
    const scroll = scrollRef.current;
    if (!enabled || !scroll) return;
    const apply = () =>
      setViewport((previous) => {
        const width = scroll.clientWidth || previous.width;
        return width === previous.width && scroll.scrollLeft === previous.scrollLeft
          ? previous
          : { width, scrollLeft: scroll.scrollLeft };
      });
    // The initial measurement is synchronous so first paint sees real bounds.
    apply();
    let frame = 0;
    const measure = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        apply();
      });
    };
    const observer = new ResizeObserver(measure);
    observer.observe(scroll);
    scroll.addEventListener("scroll", measure);
    return () => {
      cancelAnimationFrame(frame);
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

  // Loading another document restores the default zoom; remounting the panel keeps it.
  const seenProject = useRef(state.project.id);
  useEffect(() => {
    if (seenProject.current === state.project.id) return;
    seenProject.current = state.project.id;
    timelineZoomStore.set(1);
  }, [state.project.id]);

  const zoomTo = useCallback(
    (requested: number, pointerX?: number, restoreScroll?: number) => {
      const scroll = scrollRef.current;
      if (!scroll) return;
      const zoom = Math.max(bounds.min, Math.min(bounds.max, requested));
      const pixelsPerSecond = timelinePixelsPerSecond();
      const visibleWidth = Math.max(1, viewportWidth.current - TIMELINE_LABEL_WIDTH);
      const playheadX = currentTime.current * pixelsPerSecond - scroll.scrollLeft;
      const anchorX =
        pointerX === undefined
          ? playheadX >= 0 && playheadX <= visibleWidth
            ? playheadX
            : visibleWidth / 2
          : Math.max(0, pointerX - scroll.getBoundingClientRect().left - TIMELINE_LABEL_WIDTH);
      const time = (scroll.scrollLeft + anchorX) / pixelsPerSecond;
      const nextScroll = Math.max(0, restoreScroll ?? time * zoom * TIMELINE_BASE_SCALE - anchorX);
      if (zoom === timelineZoomStore.get()) {
        scroll.scrollLeft = nextScroll;
        return;
      }
      pendingScroll.current = nextScroll;
      // Seed the viewport with the applied scroll so the async scroll event
      // finds nothing new and does not schedule a second render.
      setViewport((previous) =>
        previous.scrollLeft === nextScroll ? previous : { ...previous, scrollLeft: nextScroll },
      );
      timelineZoomStore.set(zoom);
    },
    [bounds.min, bounds.max, scrollRef],
  );

  useEffect(() => {
    const scroll = scrollRef.current;
    if (!enabled || !scroll) return;
    let frame = 0;
    let pending: { zoom: number; pointerX: number } | undefined;
    const flush = () => {
      frame = 0;
      const next = pending;
      pending = undefined;
      if (next) zoomTo(next.zoom, next.pointerX);
    };
    const wheel = (event: WheelEvent) => {
      if (isEditableShortcutTarget(event.target)) return;
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? scroll.clientWidth : 1;
      if (event.altKey && !event.ctrlKey && !event.metaKey && event.deltaY !== 0) {
        event.preventDefault();
        const factor = Math.exp(-Math.max(-300, Math.min(300, event.deltaY * unit)) * 0.002);
        pending = {
          zoom: (pending?.zoom ?? timelineZoomStore.get()) * factor,
          pointerX: event.clientX,
        };
        if (!frame) frame = requestAnimationFrame(flush);
      } else if (event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey) {
        event.preventDefault();
        scroll.scrollLeft += (event.deltaY || event.deltaX) * unit;
      }
    };
    scroll.addEventListener("wheel", wheel, { passive: false });
    return () => {
      cancelAnimationFrame(frame);
      scroll.removeEventListener("wheel", wheel);
    };
  }, [enabled, scrollRef, zoomTo]);

  const handleShortcut = (shortcut: TimelineShortcut) => {
    const scroll = scrollRef.current;
    if (!scroll) return false;
    const zoom = timelineZoomStore.get();
    if (shortcut === "zoom-in" || shortcut === "zoom-out") {
      zoomTo(zoom * (shortcut === "zoom-in" ? 1.25 : 1 / 1.25));
    } else if (shortcut === "zoom-frames") {
      const isFrames = Math.abs(zoom - bounds.max) < 0.000001;
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
      if (Math.abs(zoom - bounds.min) < 0.000001 && restoredView.current) {
        const previous = restoredView.current;
        restoredView.current = undefined;
        zoomTo(previous.zoom, undefined, previous.scrollLeft);
      } else {
        restoredView.current = { zoom, scrollLeft: scroll.scrollLeft };
        zoomTo(bounds.min, undefined, 0);
      }
    } else if (shortcut === "reveal-time") {
      scroll.scrollLeft = Math.max(
        0,
        state.currentTime * timelinePixelsPerSecond() - (viewport.width - TIMELINE_LABEL_WIDTH) / 2,
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
