import type { Translate } from "../i18n/core";
import { useI18n } from "../i18n/react";
import type { BufferVisualization } from "../renderer/render-buffers";
import { BUFFER_VISUALIZATIONS } from "../renderer/render-buffers";
import { ContextMenu } from "./context-menu/ContextMenu";
import type { ContextMenuItem } from "./context-menu/context-menu-model";

export interface ViewportContextMenuActions {
  bufferView: BufferVisualization;
  canCopyFrame: boolean;
  canCropComposition: boolean;
  canExportFrame: boolean;
  canInvertSelection: boolean;
  canSelectChildren: boolean;
  copyUnavailableReason: string;
  copyFrame(): void;
  cropComposition(): void;
  cropUnavailableReason: string;
  exportFrame(): void;
  exportUnavailableReason: string;
  invertSelection(): void;
  onClose(): void;
  openCompositionSettings(): void;
  revealComposition(): void;
  selectChildren(): void;
  setBufferView(value: BufferVisualization): void;
  setPreviewQuality(value: 1 | 0.5 | 0.25): void;
  setViewCount(value: number): void;
  setZoom(value: number): void;
  toggleGrid(): void;
  toggleGuides(): void;
  toggleLayerControls(): void;
  toggleOrigin(): void;
  previewQuality: 1 | 0.5 | 0.25;
  showGrid: boolean;
  showGuides: boolean;
  showLayerControls: boolean;
  showOrigin: boolean;
  viewCount: number;
  x: number;
  y: number;
  zoom: number;
}

export function viewportContextMenuItems(
  actions: ViewportContextMenuActions,
  t: Translate,
): ContextMenuItem[] {
  const zooms = [0.25, 0.5, 1, 2] as const;
  return [
    {
      id: "composition-settings",
      kind: "command",
      label: t("viewport.menu.compositionSettings"),
      shortcut: "Ctrl/Cmd+K",
      onSelect: actions.openCompositionSettings,
    },
    {
      id: "reveal-composition",
      kind: "command",
      label: t("viewport.menu.revealComposition"),
      onSelect: actions.revealComposition,
    },
    {
      disabled: !actions.canCropComposition,
      disabledReason: actions.cropUnavailableReason,
      id: "crop-composition",
      kind: "command",
      label: t("viewport.menu.cropComposition"),
      onSelect: actions.cropComposition,
    },
    { id: "selection-separator", kind: "separator" },
    {
      disabled: !actions.canInvertSelection,
      disabledReason: t("viewport.menu.noSelection"),
      id: "invert-selection",
      kind: "command",
      label: t("viewport.menu.invertSelection"),
      onSelect: actions.invertSelection,
    },
    {
      disabled: !actions.canSelectChildren,
      disabledReason: t("viewport.menu.noChildren"),
      id: "select-children",
      kind: "command",
      label: t("viewport.menu.selectChildren"),
      onSelect: actions.selectChildren,
    },
    { id: "composition-separator", kind: "separator" },
    {
      id: "fit",
      kind: "command",
      label: t("viewport.menu.fit"),
      shortcut: "Shift+/",
      onSelect: () => actions.setZoom(0.22),
    },
    {
      id: "zoom",
      kind: "submenu",
      label: t("viewport.menu.zoom"),
      items: zooms.map((zoom) => ({
        checked: Math.abs(actions.zoom - zoom) < 0.001,
        group: "viewport-zoom",
        id: `zoom-${zoom}`,
        kind: "radio" as const,
        label: `${Math.round(zoom * 100)}%`,
        onSelect: () => actions.setZoom(zoom),
      })),
    },
    { id: "view-separator", kind: "separator" },
    {
      id: "resolution",
      kind: "submenu",
      label: t("viewport.menu.resolution"),
      items: ([1, 0.5, 0.25] as const).map((quality) => ({
        checked: actions.previewQuality === quality,
        group: "preview-resolution",
        id: `resolution-${quality}`,
        kind: "radio" as const,
        label: t(
          quality === 1
            ? "viewport.menu.resolution.full"
            : quality === 0.5
              ? "viewport.menu.resolution.half"
              : "viewport.menu.resolution.quarter",
        ),
        onSelect: () => actions.setPreviewQuality(quality),
      })),
    },
    {
      id: "buffer",
      kind: "submenu",
      label: t("viewport.menu.buffer"),
      items: BUFFER_VISUALIZATIONS.map((buffer) => ({
        checked: actions.bufferView === buffer,
        group: "viewport-buffer",
        id: `buffer-${buffer}`,
        kind: "radio" as const,
        label: viewportBufferLabel(buffer, t),
        onSelect: () => actions.setBufferView(buffer),
      })),
    },
    {
      id: "view-count",
      kind: "submenu",
      label: t("viewport.menu.viewCount"),
      items: [1, 2].map((count) => ({
        checked: actions.viewCount === count,
        group: "viewport-view-count",
        id: `view-count-${count}`,
        kind: "radio" as const,
        label:
          count === 1 ? t("viewport.viewCount", { count }) : t("viewport.viewsCount", { count }),
        onSelect: () => actions.setViewCount(count),
      })),
    },
    { id: "capture-separator", kind: "separator" },
    {
      disabled: !actions.canCopyFrame,
      disabledReason: actions.copyUnavailableReason,
      id: "copy-frame",
      kind: "command",
      label: t("viewport.menu.copyFrame"),
      onSelect: actions.copyFrame,
    },
    {
      disabled: !actions.canExportFrame,
      disabledReason: actions.exportUnavailableReason,
      id: "export-frame",
      kind: "command",
      label: t("viewport.menu.exportFrame"),
      onSelect: actions.exportFrame,
    },
    { id: "overlay-separator", kind: "separator" },
    {
      checked: actions.showGuides,
      id: "guides",
      kind: "checkbox",
      label: t("viewport.menu.guides"),
      onSelect: actions.toggleGuides,
    },
    {
      checked: actions.showGrid,
      id: "grid",
      kind: "checkbox",
      label: t("viewport.menu.grid"),
      onSelect: actions.toggleGrid,
    },
    {
      checked: actions.showOrigin,
      id: "origin",
      kind: "checkbox",
      label: t("viewport.menu.origin"),
      onSelect: actions.toggleOrigin,
    },
    {
      checked: actions.showLayerControls,
      id: "layer-controls",
      kind: "checkbox",
      label: t("viewport.menu.layerControls"),
      onSelect: actions.toggleLayerControls,
    },
  ];
}

export function ViewportContextMenu(actions: ViewportContextMenuActions) {
  const { t } = useI18n();
  return (
    <ContextMenu
      ariaLabel={t("viewport.menu.label")}
      items={viewportContextMenuItems(actions, t)}
      onClose={actions.onClose}
      open
      x={actions.x}
      y={actions.y}
    />
  );
}

export function viewportBufferLabel(mode: BufferVisualization, t: Translate): string {
  const keys = {
    alpha: "viewport.buffer.alpha",
    beauty: "viewport.buffer.beauty",
    depthFog: "viewport.buffer.depthFog",
    depthOfField: "viewport.buffer.depthOfField",
    linearColor: "viewport.buffer.linearColor",
    luminance: "viewport.buffer.luminance",
    materialId: "viewport.buffer.materialId",
    motionVector: "viewport.buffer.motionVector",
    normal: "viewport.buffer.normal",
    objectId: "viewport.buffer.objectId",
    selectionIsolation: "viewport.buffer.selectionIsolation",
    vectorMotionBlur: "viewport.buffer.vectorMotionBlur",
    worldPosition: "viewport.buffer.worldPosition",
  } as const;
  return t(keys[mode]);
}
