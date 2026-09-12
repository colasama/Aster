import { useState } from "react";
import { useI18n } from "../../i18n/react";
import { VIEWPORT_ZOOM_PRESETS, type ViewportZoomMode } from "../../ui/viewport-zoom";

export function ViewportZoomControl({
  zoom,
  mode,
  setZoom,
  fitView,
}: {
  zoom: number;
  mode: ViewportZoomMode;
  setZoom(zoom: number): void;
  fitView(mode: "fit" | "fit100"): void;
}) {
  const { t } = useI18n();
  const [draft, setDraft] = useState<string>();
  const percent = Math.round(zoom * 10_000) / 100;
  const label =
    mode === "manual"
      ? `${percent}%`
      : `${t(mode === "fit" ? "viewport.menu.fit" : "viewport.fit100")} (${percent}%)`;
  return (
    <div className="preview-zoom-control">
      <input
        aria-label={t("viewport.zoom")}
        title={label}
        value={draft ?? label}
        onFocus={(event) => event.currentTarget.select()}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => {
          if (draft !== undefined) {
            const value = Number(draft.trim().replace(/%$/, ""));
            if (Number.isFinite(value) && value > 0) setZoom(value / 100);
          }
          setDraft(undefined);
        }}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) return;
          if (event.key === "Enter") {
            event.preventDefault();
            event.currentTarget.blur();
          }
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            setDraft(undefined);
          }
        }}
      />
      <select
        aria-label={t("viewport.zoomPresets")}
        title={t("viewport.zoomPresets")}
        value={mode === "manual" ? String(zoom) : mode}
        onChange={(event) => {
          setDraft(undefined);
          const value = event.target.value;
          if (value === "fit" || value === "fit100") fitView(value);
          else setZoom(Number(value));
        }}
      >
        <option value="fit">{t("viewport.menu.fit")}</option>
        <option value="fit100">{t("viewport.fit100")}</option>
        {mode === "manual" && !VIEWPORT_ZOOM_PRESETS.some((value) => value === zoom) && (
          <option value={zoom}>{percent}%</option>
        )}
        {VIEWPORT_ZOOM_PRESETS.map((value) => (
          <option key={value} value={value}>
            {value * 100}%
          </option>
        ))}
      </select>
    </div>
  );
}
