import { Camera, ChevronRight, Grid3X3, Image, Move3D, Ruler, Sparkles } from "lucide-react";
import type { Composition } from "../../core/types";
import { useI18n } from "../../i18n/react";
import { BUFFER_VISUALIZATIONS, type BufferVisualization } from "../../renderer/gpu/render-buffers";
import { useEditor } from "../../state/editor-store";
import type { ViewportZoomMode } from "../../ui/viewport-zoom";
import { ContextMenu } from "../context-menu/ContextMenu";
import { useContextMenuTrigger } from "../context-menu/use-context-menu-trigger";
import { PreviewTimecode } from "./PreviewTimecode";
import { ViewportZoomControl } from "./ViewportZoomControl";
import { bufferViewLabel } from "./viewport-rendering";

export function ViewportHeader({
  composition,
  view,
  setView,
  viewCount,
  setViewCount,
  space,
  setSpace,
}: {
  composition: Composition;
  view: "active" | "custom";
  setView(view: "active" | "custom"): void;
  viewCount: number;
  setViewCount(count: number): void;
  space: "local" | "world";
  setSpace(space: "local" | "world"): void;
}) {
  const { t } = useI18n();
  return (
    <div className="viewport-toolbar">
      <span
        className="viewport-composition-name"
        title={`${composition.name} · ${composition.width} × ${composition.height}`}
      >
        <ChevronRight size={12} />
        {composition.name}
      </span>
      <span className="toolbar-gap" />
      <button
        type="button"
        title={t("viewport.toggleSpace")}
        onClick={() => setSpace(space === "local" ? "world" : "local")}
      >
        <Move3D size={14} />
        {t(space === "local" ? "viewport.space.local" : "viewport.space.world")}
      </button>
      <select
        aria-label={t("viewport.switchCamera")}
        value={view}
        disabled={viewCount === 2}
        onChange={(event) => setView(event.target.value as "active" | "custom")}
      >
        <option value="active">{t("viewport.activeCamera")}</option>
        <option value="custom">{t("viewport.customView")}</option>
      </select>
      <select
        aria-label={t("viewport.menu.viewCount")}
        value={viewCount}
        onChange={(event) => setViewCount(Number(event.target.value))}
      >
        <option value={1}>{t("viewport.viewCount", { count: 1 })}</option>
        <option value={2}>{t("viewport.viewsCount", { count: 2 })}</option>
      </select>
    </div>
  );
}

export function ViewportFooter({
  composition,
  zoom,
  zoomMode,
  setZoom,
  fitView,
  bufferView,
  setBufferView,
  gpuAvailable,
  rendererStatus,
  readOnly,
  snapshot,
  rulers,
  toggleRulers,
  guidesLocked,
  toggleGuidesLocked,
  clearGuides,
  hasGuides,
}: {
  composition: Composition;
  zoom: number;
  zoomMode: ViewportZoomMode;
  setZoom(value: number): void;
  fitView(mode: "fit" | "fit100"): void;
  bufferView: BufferVisualization;
  setBufferView(value: BufferVisualization): void;
  gpuAvailable: boolean;
  rendererStatus: { tone: string; title: string; label: string };
  readOnly: boolean;
  snapshot: {
    ready: boolean;
    available: boolean;
    showing: boolean;
    capture(): void;
    show(): void;
    hide(): void;
  };
  rulers: boolean;
  toggleRulers(): void;
  guidesLocked: boolean;
  toggleGuidesLocked(): void;
  clearGuides(): void;
  hasGuides: boolean;
}) {
  const { state, dispatch } = useEditor();
  const { t } = useI18n();
  const menu = useContextMenuTrigger();
  return (
    <div
      onKeyDown={(event) => {
        if (event.key !== "F5" || event.nativeEvent.isComposing) return;
        event.preventDefault();
        event.stopPropagation();
        if (event.shiftKey && !event.repeat && snapshot.ready) snapshot.capture();
        else if (!event.shiftKey) snapshot.show();
      }}
      onKeyUp={(event) => {
        if (event.key === "F5") snapshot.hide();
      }}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) snapshot.hide();
      }}
      className="viewport-status"
      role="toolbar"
      aria-label={t("viewport.previewControls")}
    >
      <div className="viewport-control-group">
        <ViewportZoomControl zoom={zoom} mode={zoomMode} setZoom={setZoom} fitView={fitView} />
        <PreviewTimecode
          key={composition.id}
          composition={composition}
          time={state.currentTime}
          disabled={readOnly}
          onSeek={(time) => {
            dispatch({ type: "setPlaying", playing: false });
            dispatch({ type: "setTime", time });
          }}
        />
      </div>
      <div className="viewport-control-group">
        <button
          type="button"
          aria-label={t("viewport.snapshot.take")}
          title={t("viewport.snapshot.take")}
          disabled={!snapshot.ready}
          onClick={snapshot.capture}
        >
          <Camera size={15} />
        </button>
        <button
          type="button"
          aria-label={t("viewport.snapshot.show")}
          title={t("viewport.snapshot.show")}
          disabled={!snapshot.available}
          aria-pressed={snapshot.showing}
          onPointerDown={(event) => {
            if (event.button !== 0) return;
            event.currentTarget.setPointerCapture(event.pointerId);
            snapshot.show();
          }}
          onPointerUp={snapshot.hide}
          onPointerCancel={snapshot.hide}
          onLostPointerCapture={snapshot.hide}
          onBlur={snapshot.hide}
          onKeyDown={(event) => {
            if (event.key === " " || event.key === "Enter") {
              event.preventDefault();
              snapshot.show();
            }
          }}
          onKeyUp={(event) => {
            if (event.key === " " || event.key === "Enter") {
              event.preventDefault();
              snapshot.hide();
            }
          }}
        >
          <Image size={15} />
        </button>
      </div>
      <div className="viewport-control-group">
        <select
          aria-label={t("viewport.menu.resolution")}
          value={state.previewQuality}
          onChange={(event) =>
            dispatch({
              type: "setPreviewQuality",
              quality: Number(event.target.value) as 1 | 0.5 | 0.25,
            })
          }
        >
          <option value={1}>{t("viewport.menu.resolution.full")}</option>
          <option value={0.5}>{t("viewport.menu.resolution.half")}</option>
          <option value={0.25}>{t("viewport.menu.resolution.quarter")}</option>
        </select>
        <select
          aria-label={t("viewport.buffer.label")}
          title={t("viewport.buffer.hint")}
          value={bufferView}
          disabled={!gpuAvailable}
          onChange={(event) => setBufferView(event.target.value as BufferVisualization)}
        >
          {BUFFER_VISUALIZATIONS.map((mode) => (
            <option key={mode} value={mode}>
              {bufferViewLabel(mode, t)}
            </option>
          ))}
        </select>
      </div>
      <div className="viewport-control-group">
        <button
          type="button"
          aria-label={t("viewport.displayOptions")}
          title={t("viewport.displayOptions")}
          aria-haspopup="menu"
          aria-expanded={Boolean(menu.point)}
          onClick={(event) => {
            const rect = event.currentTarget.getBoundingClientRect();
            menu.openAt(event.currentTarget, { x: rect.left, y: rect.top });
          }}
        >
          <Grid3X3 size={15} />
        </button>
        <button
          type="button"
          aria-label={t("viewport.rulers")}
          title={t("viewport.rulers")}
          aria-pressed={rulers}
          onClick={toggleRulers}
        >
          <Ruler size={15} />
        </button>
      </div>
      <span
        className={`renderer-status compact ${rendererStatus.tone}`}
        role="img"
        title={rendererStatus.title}
        aria-label={rendererStatus.label}
      >
        <Sparkles size={12} />
      </span>
      {menu.point && (
        <ContextMenu
          open
          ariaLabel={t("viewport.displayOptions")}
          x={menu.point.x}
          y={menu.point.y}
          onClose={menu.close}
          items={[
            ...(
              [
                ["grid", "viewport.menu.grid", state.showGrid],
                ["guides", "viewport.menu.guides", state.showGuides],
                ["origin", "viewport.menu.origin", state.showOrigin],
                ["layerControls", "viewport.menu.layerControls", state.showLayerControls],
              ] as const
            ).map(([view, label, checked]) => ({
              id: view,
              kind: "checkbox" as const,
              label: t(label),
              checked,
              onSelect: () => dispatch({ type: "toggleView", view }),
            })),
            { id: "separator", kind: "separator" },
            {
              id: "rulers",
              kind: "checkbox",
              label: t("viewport.rulers"),
              checked: rulers,
              onSelect: toggleRulers,
            },
            {
              id: "lock",
              kind: "checkbox",
              label: t("viewport.guides.lock"),
              checked: guidesLocked,
              onSelect: toggleGuidesLocked,
            },
            {
              id: "clear",
              kind: "command",
              label: t("viewport.guides.clear"),
              disabled: guidesLocked || !hasGuides,
              onSelect: clearGuides,
            },
          ]}
        />
      )}
    </div>
  );
}
