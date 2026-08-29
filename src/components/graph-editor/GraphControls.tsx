import type { Translate } from "../../i18n/core";
import { type GraphTrack, type GraphType, resolveGraphType } from "./model";

interface GraphSidebarProps {
  graphType: GraphType;
  hasLayer: boolean;
  hiddenTracks: ReadonlySet<string>;
  onToggleTrack: (trackId: string) => void;
  t: Translate;
  title: string;
  trackLabel: (track: GraphTrack) => string;
  tracks: readonly GraphTrack[];
}

export function GraphSidebar({
  graphType,
  hasLayer,
  hiddenTracks,
  onToggleTrack,
  t,
  title,
  trackLabel,
  tracks,
}: GraphSidebarProps) {
  return (
    <div className="graph-sidebar">
      <strong>{title}</strong>
      <div className="graph-track-list">
        {tracks.map((track) => {
          const visible = !hiddenTracks.has(track.id);
          const resolved = resolveGraphType(graphType, track);
          const label = trackLabel(track);
          const unit = resolved === "speed" && track.unit ? `${track.unit}/s` : track.unit;
          return (
            <button
              aria-label={t(visible ? "graph.track.hide" : "graph.track.show", { label })}
              aria-pressed={visible}
              className={visible ? "active" : ""}
              key={track.id}
              onClick={() => onToggleTrack(track.id)}
              type="button"
            >
              <span className="property-color" style={{ background: track.color }} />
              <span>{label}</span>
              <small>
                {t(resolved === "speed" ? "graph.badge.speed" : "graph.badge.value")}
                {unit ? ` · ${unit}` : ""}
              </small>
            </button>
          );
        })}
        {hasLayer && tracks.length === 0 && (
          <span className="graph-empty">{t("graph.noAnimated")}</span>
        )}
      </div>
    </div>
  );
}

interface GraphToolbarProps {
  allowBetweenFrames: boolean;
  autoZoomHeight: boolean;
  canFitAll: boolean;
  canFitSelection: boolean;
  graphType: GraphType;
  onFitAll: () => void;
  onFitSelection: () => void;
  onGraphType: (type: GraphType) => void;
  onToggleAutoZoomHeight: () => void;
  onToggleBetweenFrames: () => void;
  onToggleLayerBounds: () => void;
  onToggleReference: () => void;
  showLayerBounds: boolean;
  showReferenceGraph: boolean;
  t: Translate;
}

export function GraphToolbar({
  allowBetweenFrames,
  autoZoomHeight,
  canFitAll,
  canFitSelection,
  graphType,
  onFitAll,
  onFitSelection,
  onGraphType,
  onToggleAutoZoomHeight,
  onToggleBetweenFrames,
  onToggleLayerBounds,
  onToggleReference,
  showLayerBounds,
  showReferenceGraph,
  t,
}: GraphToolbarProps) {
  return (
    <div className="graph-toolbar">
      <label>
        <span>{t("graph.type.label")}</span>
        <select
          aria-label={t("graph.type.label")}
          onChange={(event) => onGraphType(event.target.value as GraphType)}
          value={graphType}
        >
          <option value="auto">{t("graph.type.auto")}</option>
          <option value="value">{t("graph.type.value")}</option>
          <option value="speed">{t("graph.type.speed")}</option>
        </select>
      </label>
      <button disabled={!canFitSelection} onClick={onFitSelection} type="button">
        {t("graph.fitSelection")}
      </button>
      <button disabled={!canFitAll} onClick={onFitAll} type="button">
        {t("graph.fitAll")}
      </button>
      <button
        aria-pressed={autoZoomHeight}
        className={autoZoomHeight ? "active" : ""}
        onClick={onToggleAutoZoomHeight}
        type="button"
      >
        {t("graph.autoZoomHeight")}
      </button>
      <button
        aria-pressed={showReferenceGraph}
        className={showReferenceGraph ? "active" : ""}
        onClick={onToggleReference}
        type="button"
      >
        {t("graph.showReference")}
      </button>
      <button
        aria-pressed={showLayerBounds}
        className={showLayerBounds ? "active" : ""}
        onClick={onToggleLayerBounds}
        type="button"
      >
        {t("graph.showLayerBounds")}
      </button>
      <button
        aria-pressed={allowBetweenFrames}
        className={allowBetweenFrames ? "active" : ""}
        onClick={onToggleBetweenFrames}
        type="button"
      >
        {t("graph.allowBetweenFrames")}
      </button>
    </div>
  );
}
