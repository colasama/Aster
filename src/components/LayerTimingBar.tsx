import type { PointerEvent as ReactPointerEvent } from "react";
import type { Layer } from "../core/types";
import { useI18n } from "../i18n/react";
import type { LayerTimingDrag } from "./timeline-interactions";

export function LayerTimingBar({
  layer,
  onDragStart,
  pixelsPerSecond,
  timing,
}: {
  layer: Layer;
  onDragStart: (event: ReactPointerEvent, mode: LayerTimingDrag) => void;
  pixelsPerSecond: number;
  timing?: { inPoint: number; outPoint: number };
}) {
  const { t } = useI18n();
  const displayed = timing ?? layer;
  const startDrag = (event: ReactPointerEvent, mode: LayerTimingDrag) => {
    event.stopPropagation();
    if (event.button !== 0) return;
    event.preventDefault();
    onDragStart(event, mode);
  };
  return (
    <div
      className={`layer-bar kind-${layer.kind}`}
      onPointerDown={(event) => startDrag(event, "move")}
      style={{
        left: displayed.inPoint * pixelsPerSecond,
        width: Math.max(2, (displayed.outPoint - displayed.inPoint) * pixelsPerSecond),
      }}
      title={t("layerTiming.moveHint", { name: layer.name })}
    >
      <button
        aria-label={t("layerTiming.trimIn", { name: layer.name })}
        className="timing-handle start"
        onPointerDown={(event) => startDrag(event, "trim-in")}
        type="button"
      />
      <span>{layer.name}</span>
      <button
        aria-label={t("layerTiming.trimOut", { name: layer.name })}
        className="timing-handle end"
        onPointerDown={(event) => startDrag(event, "trim-out")}
        type="button"
      />
    </div>
  );
}
