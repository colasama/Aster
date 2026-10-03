import { type PointerEvent as ReactPointerEvent, type RefObject, useEffect, useRef } from "react";
import { snapTimelineTime, type TimelineSnapTarget } from "../../core/animation/timeline-editing";
import { TIMELINE_LABEL_WIDTH } from "../../ui/timeline-zoom";
import type { StartWindowPointerDrag } from "../use-window-pointer-drag";
import { timelineScrubScrollSpeed } from "./timeline-scroll";
import { timelinePixelsPerSecond } from "./timeline-zoom-store";

/** Pointer seeks share one edge-scroll loop, including while the pointer is stationary. */
export function useTimelineScrub({
  scrollRef,
  canvasRef,
  width,
  duration,
  frameDuration,
  targets,
  seek,
  startPointerDrag,
  enabled,
  compositionId,
}: {
  scrollRef: RefObject<HTMLDivElement | null>;
  canvasRef: RefObject<HTMLDivElement | null>;
  width: number;
  duration: number;
  frameDuration: number;
  targets: readonly TimelineSnapTarget[];
  seek: (time: number) => void;
  startPointerDrag: StartWindowPointerDrag;
  enabled: boolean;
  compositionId: string;
}) {
  const stopRef = useRef<(() => void) | undefined>(undefined);
  // A hidden panel or a composition switch must never retain a scrolling gesture.
  useEffect(() => {
    if (!enabled || !compositionId) stopRef.current?.();
    return () => stopRef.current?.();
  }, [enabled, compositionId]);
  return (event: ReactPointerEvent) => {
    if (event.button !== 0 || !enabled) return;
    const scroll = scrollRef.current;
    if (!scroll) return;
    event.preventDefault();
    stopRef.current?.();
    let pointerX = event.clientX;
    let bypass = event.ctrlKey || event.metaKey;
    let frame = 0;
    let previousTime = 0;
    let stopped = false;
    let lastSeek: number | undefined;
    const geometry = () => ({
      left: scroll.getBoundingClientRect().left + TIMELINE_LABEL_WIDTH,
      width: Math.max(1, (scroll.clientWidth || width) - TIMELINE_LABEL_WIDTH),
    });
    const scrub = () => {
      const track = geometry();
      const scale = timelinePixelsPerSecond();
      const x = Math.max(0, Math.min(track.width - 1, pointerX - track.left));
      const time = Math.min(duration, (scroll.scrollLeft + x) / scale);
      const snapped = snapTimelineTime(time, frameDuration, scale, targets, bypass).time;
      const first = Math.ceil(scroll.scrollLeft / scale / frameDuration) * frameDuration;
      const last =
        Math.floor((scroll.scrollLeft + track.width - 1) / scale / frameDuration) * frameDuration;
      const visibleTime = Math.max(0, Math.min(duration, last, Math.max(first, snapped)));
      canvasRef.current?.style.setProperty("--timeline-playhead-time", String(visibleTime));
      if (visibleTime !== lastSeek) seek(visibleTime);
      lastSeek = visibleTime;
    };
    const tick = (now: number) => {
      frame = 0;
      if (stopped) return;
      const track = geometry();
      const speed = timelineScrubScrollSpeed(pointerX, track.left, track.width);
      const elapsed = Math.min(50, Math.max(0, now - previousTime)) / 1000;
      previousTime = now;
      const maximum = Math.max(0, duration * timelinePixelsPerSecond() - track.width);
      const next = Math.max(0, Math.min(maximum, scroll.scrollLeft + speed * elapsed));
      if (next === scroll.scrollLeft) return;
      scroll.scrollLeft = next;
      scrub();
      frame = requestAnimationFrame(tick);
    };
    const stop = () => {
      stopped = true;
      cancelAnimationFrame(frame);
      if (stopRef.current === stop) stopRef.current = undefined;
    };
    stopRef.current = stop;
    scrub();
    startPointerDrag(event.pointerId, {
      onMove: (moveEvent) => {
        if (stopped) return;
        pointerX = moveEvent.clientX;
        bypass = moveEvent.ctrlKey || moveEvent.metaKey;
        scrub();
        if (!frame) {
          previousTime = performance.now();
          frame = requestAnimationFrame(tick);
        }
      },
      onCommit: stop,
      onCancel: stop,
    });
  };
}
