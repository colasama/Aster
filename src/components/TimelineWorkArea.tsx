import { type PointerEvent as ReactPointerEvent, useEffect, useRef, useState } from "react";
import { useI18n } from "../i18n/react";
import {
  moveWorkArea,
  setWorkAreaBoundary,
  type TimelineWorkArea as TimelineWorkAreaValue,
} from "./timeline-interactions";
import type { StartWindowPointerDrag } from "./use-window-pointer-drag";

type WorkAreaDrag = "start" | "move" | "end";

export function TimelineWorkArea({
  duration,
  frameDuration,
  onChange,
  pixelsPerSecond,
  startPointerDrag,
  value,
}: {
  duration: number;
  frameDuration: number;
  onChange: (value: TimelineWorkAreaValue) => void;
  pixelsPerSecond: number;
  startPointerDrag: StartWindowPointerDrag;
  value: TimelineWorkAreaValue;
}) {
  const { t } = useI18n();
  const [preview, setPreview] = useState<TimelineWorkAreaValue>();
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const displayed = preview ?? value;
  const startDrag = (event: ReactPointerEvent, mode: WorkAreaDrag) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const startX = event.clientX;
    const initial = displayed;
    let next = initial;
    startPointerDrag(event.pointerId, {
      onMove: (moveEvent) => {
        const delta = (moveEvent.clientX - startX) / pixelsPerSecond;
        next =
          mode === "move"
            ? moveWorkArea(initial, initial.start + delta, duration, frameDuration)
            : setWorkAreaBoundary(
                initial,
                mode,
                (mode === "start" ? initial.start : initial.end) + delta,
                duration,
                frameDuration,
              );
        if (mounted.current) setPreview(next);
      },
      onCommit: () => {
        if (!mounted.current) return;
        setPreview(undefined);
        if (next.start !== initial.start || next.end !== initial.end) onChange(next);
      },
      onCancel: () => {
        if (mounted.current) setPreview(undefined);
      },
    });
  };
  return (
    <div
      className="work-area"
      style={{
        left: displayed.start * pixelsPerSecond,
        width: Math.max(2, (displayed.end - displayed.start) * pixelsPerSecond),
      }}
    >
      <button
        aria-label={t("timeline.workArea.start")}
        className="work-area-handle start"
        onPointerDown={(event) => startDrag(event, "start")}
        type="button"
      />
      <button
        aria-label={t("timeline.workArea.move")}
        className="work-area-move"
        onPointerDown={(event) => startDrag(event, "move")}
        title={t("timeline.workArea.hint")}
        type="button"
      />
      <button
        aria-label={t("timeline.workArea.end")}
        className="work-area-handle end"
        onPointerDown={(event) => startDrag(event, "end")}
        type="button"
      />
    </div>
  );
}
