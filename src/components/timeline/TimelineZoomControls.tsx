import { ZoomIn, ZoomOut } from "lucide-react";
import { useI18n } from "../../i18n/react";
import { useTimelineZoom } from "./timeline-zoom-store";

export function TimelineZoomControls({
  bounds,
  onZoom,
}: {
  bounds: { min: number; max: number };
  onZoom: (zoom: number) => void;
}) {
  const { t } = useI18n();
  const zoom = useTimelineZoom();
  return (
    <>
      <button
        aria-label={t("timeline.zoomOut")}
        onClick={() => onZoom(zoom / 1.25)}
        title={`${t("timeline.zoomOut")} (-)`}
        type="button"
      >
        <ZoomOut size={13} />
      </button>
      <input
        aria-label={t("timeline.zoom")}
        max={Math.log(bounds.max)}
        min={Math.log(bounds.min)}
        onChange={(event) => onZoom(Math.exp(Number(event.target.value)))}
        step="any"
        type="range"
        value={Math.log(Math.max(bounds.min, Math.min(bounds.max, zoom)))}
      />
      <button
        aria-label={t("timeline.zoomIn")}
        onClick={() => onZoom(zoom * 1.25)}
        title={`${t("timeline.zoomIn")} (=)`}
        type="button"
      >
        <ZoomIn size={13} />
      </button>
    </>
  );
}
