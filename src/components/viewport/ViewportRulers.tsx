import { type PointerEvent, type RefObject, useCallback, useEffect, useRef, useState } from "react";
import { createId } from "../../core/types";
import { useI18n } from "../../i18n/react";
import { rulerTicks, type ViewerGuide } from "../../ui/viewer-guides";

export function ViewportRulers({
  stageRef,
  width,
  height,
  zoom,
  guides,
  onChange,
  locked,
}: {
  stageRef: RefObject<HTMLDivElement | null>;
  width: number;
  height: number;
  zoom: number;
  guides: ViewerGuide[];
  onChange(guides: ViewerGuide[]): void;
  locked: boolean;
}) {
  const { t } = useI18n();
  const [draft, setDraft] = useState<ViewerGuide>();
  const gesture = useRef<
    | { pointerId: number; guide: ViewerGuide; position: number; target: HTMLButtonElement }
    | undefined
  >(undefined);
  const cancelGesture = useCallback(() => {
    const active = gesture.current;
    gesture.current = undefined;
    setDraft(undefined);
    if (active?.target.hasPointerCapture(active.pointerId))
      active.target.releasePointerCapture(active.pointerId);
  }, []);
  useEffect(() => {
    const cancelOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || !gesture.current) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      cancelGesture();
    };
    window.addEventListener("blur", cancelGesture);
    window.addEventListener("keydown", cancelOnEscape, true);
    return () => {
      window.removeEventListener("blur", cancelGesture);
      window.removeEventListener("keydown", cancelOnEscape, true);
    };
  }, [cancelGesture]);
  const coordinate = (event: PointerEvent, axis: "x" | "y") => {
    const rect = stageRef.current?.getBoundingClientRect();
    if (!rect) return 0;
    return Math.round(
      axis === "x"
        ? ((event.clientX - rect.left) / rect.width) * width
        : ((event.clientY - rect.top) / rect.height) * height,
    );
  };
  const begin = (event: PointerEvent<HTMLButtonElement>, guide: ViewerGuide) => {
    if (locked || event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.focus({ preventScroll: true });
    gesture.current = {
      target: event.currentTarget,
      pointerId: event.pointerId,
      guide,
      position: coordinate(event, guide.axis),
    };
    setDraft({ ...guide, position: gesture.current.position });
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const finish = (event: PointerEvent<HTMLButtonElement>, cancel = false) => {
    const active = gesture.current;
    if (!active || active.pointerId !== event.pointerId) return;
    event.stopPropagation();
    gesture.current = undefined;
    setDraft(undefined);
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
    if (cancel) return;
    const next = guides.filter((guide) => guide.id !== active.guide.id);
    const max = active.guide.axis === "x" ? width : height;
    if (active.position >= 0 && active.position <= max)
      next.push({ ...active.guide, position: active.position });
    onChange(next);
  };
  const events = {
    onPointerMove(event: PointerEvent<HTMLButtonElement>) {
      const active = gesture.current;
      if (!active || active.pointerId !== event.pointerId) return;
      event.stopPropagation();
      active.position = coordinate(event, active.guide.axis);
      setDraft({ ...active.guide, position: active.position });
    },
    onPointerUp: (event: PointerEvent<HTMLButtonElement>) => finish(event),
    onPointerCancel: (event: PointerEvent<HTMLButtonElement>) => finish(event, true),
    onLostPointerCapture: (event: PointerEvent<HTMLButtonElement>) => finish(event, true),
  };
  const visible = [
    ...guides.filter((guide) => guide.id !== draft?.id),
    ...(draft ? [draft] : []),
  ].map((guide) => ({
    ...guide,
    position: Math.max(0, Math.min(guide.axis === "x" ? width : height, guide.position)),
  }));
  return (
    <>
      {(["y", "x"] as const).map((axis) => (
        <button
          key={axis}
          type="button"
          className={`viewport-ruler ruler-${axis}`}
          aria-label={t(axis === "y" ? "viewport.ruler.horizontal" : "viewport.ruler.vertical")}
          title={t("viewport.ruler.hint")}
          disabled={locked}
          onPointerDown={(event) => begin(event, { id: createId(), axis, position: 0 })}
          onKeyDown={(event) => {
            if (event.key !== "Enter" && event.key !== " ") return;
            event.preventDefault();
            event.stopPropagation();
            onChange([
              ...guides,
              { id: createId(), axis, position: Math.round((axis === "x" ? width : height) / 2) },
            ]);
          }}
          {...events}
        >
          {rulerTicks(axis === "y" ? width : height, zoom).map((value) => (
            <span key={value} style={axis === "y" ? { left: value * zoom } : { top: value * zoom }}>
              {value}
            </span>
          ))}
        </button>
      ))}
      {visible.map((guide) => (
        <button
          type="button"
          key={guide.id}
          className={`viewport-guide guide-${guide.axis}`}
          style={
            guide.axis === "x" ? { left: guide.position * zoom } : { top: guide.position * zoom }
          }
          aria-label={t("viewport.guide.position", {
            axis: guide.axis.toUpperCase(),
            value: guide.position,
          })}
          title={t("viewport.guide.hint")}
          disabled={locked}
          onPointerDown={(event) => begin(event, guide)}
          onDoubleClick={(event) => {
            event.stopPropagation();
            onChange(guides.filter((candidate) => candidate.id !== guide.id));
          }}
          onKeyDown={(event) => {
            if (
              ![
                "Delete",
                "Backspace",
                "ArrowLeft",
                "ArrowRight",
                "ArrowUp",
                "ArrowDown",
                "Escape",
              ].includes(event.key)
            )
              return;
            event.preventDefault();
            event.stopPropagation();
            if (event.key === "Escape") {
              gesture.current = undefined;
              setDraft(undefined);
              return;
            }
            if (event.key === "Delete" || event.key === "Backspace") {
              onChange(guides.filter((candidate) => candidate.id !== guide.id));
              return;
            }
            const delta =
              (event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 1) *
              (event.shiftKey ? 10 : 1);
            const position = Math.min(
              guide.axis === "x" ? width : height,
              Math.max(0, guide.position + delta),
            );
            onChange(
              guides.map((candidate) =>
                candidate.id === guide.id ? { ...guide, position } : candidate,
              ),
            );
          }}
          {...events}
        />
      ))}
    </>
  );
}
