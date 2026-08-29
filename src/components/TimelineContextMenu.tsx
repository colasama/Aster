import type { Translate } from "../i18n/core";
import { useI18n } from "../i18n/react";
import { ContextMenu } from "./context-menu/ContextMenu";
import type { ContextMenuItem } from "./context-menu/context-menu-model";

export type TimelineCreateKind =
  | "text"
  | "shape"
  | "solid"
  | "null"
  | "audio"
  | "adjustment"
  | "mesh"
  | "camera"
  | "light"
  | "generator";

export interface TimelineContextMenuActions {
  canDeleteLayers: boolean;
  canEditKeyframes: boolean;
  canInterpolate: boolean;
  canPasteKeyframes: boolean;
  canPasteLayers: boolean;
  copyKeyframes(): void;
  copyLayers(): void;
  createLayer(kind: TimelineCreateKind): void;
  cutLayers(): void;
  deleteKeyframes(): void;
  deleteLayers(): void;
  duplicateLayers(): void;
  hasKeyframeSelection: boolean;
  hasKeyframeClipboard: boolean;
  is3d: boolean;
  isAdjustment: boolean;
  isMotionBlur: boolean;
  canMotionBlur: boolean;
  isLayerTarget: boolean;
  locked: boolean;
  onClose(): void;
  openGraph(): void;
  pasteKeyframes(): void;
  pasteLayers(): void;
  precompose(): void;
  rename(): void;
  revealSource(): void;
  selectedLayerCount: number;
  setInterpolation(value: "linear" | "bezier" | "step"): void;
  toggle3d(): void;
  toggleMotionBlur(): void;
  x: number;
  y: number;
  hasSource: boolean;
}

export function timelineContextMenuItems(
  actions: TimelineContextMenuActions,
  t: Translate,
): ContextMenuItem[] {
  const noLayers = t("timeline.menu.noLayerSelection");
  const locked = t("timeline.menu.locked");
  const items: ContextMenuItem[] = [];
  if (actions.isLayerTarget) {
    items.push(
      {
        disabled: actions.locked || !actions.canDeleteLayers,
        disabledReason: actions.locked ? locked : t("timeline.menu.minimumLayer"),
        id: "cut-layers",
        kind: "command",
        label: t("timeline.menu.cut"),
        shortcut: "Ctrl/Cmd+X",
        onSelect: actions.cutLayers,
      },
      {
        id: "copy-layers",
        kind: "command",
        label: t("timeline.menu.copy"),
        shortcut: "Ctrl/Cmd+C",
        onSelect: actions.copyLayers,
      },
      {
        disabled: !actions.canPasteLayers,
        disabledReason: t("timeline.menu.noLayerClipboard"),
        id: "paste-layers",
        kind: "command",
        label: t("timeline.menu.paste"),
        shortcut: "Ctrl/Cmd+V",
        onSelect: actions.pasteLayers,
      },
      {
        id: "duplicate-layers",
        kind: "command",
        label: t("timeline.menu.duplicate"),
        shortcut: "Ctrl/Cmd+D",
        onSelect: actions.duplicateLayers,
      },
      {
        destructive: true,
        disabled: !actions.canDeleteLayers,
        disabledReason: t("timeline.menu.minimumLayer"),
        id: "delete-layers",
        kind: "command",
        label: t("timeline.menu.delete"),
        onSelect: actions.deleteLayers,
      },
      { id: "edit-separator", kind: "separator" },
      {
        disabled: actions.selectedLayerCount !== 1,
        disabledReason: t("timeline.menu.renameSingle"),
        id: "rename",
        kind: "command",
        label: t("timeline.menu.rename"),
        onSelect: actions.rename,
      },
      {
        disabled: true,
        disabledReason: t("timeline.menu.splitUnavailable"),
        id: "split",
        kind: "command",
        label: t("timeline.menu.split"),
        shortcut: "Ctrl/Cmd+Shift+D",
        onSelect: () => undefined,
      },
      {
        disabled: actions.selectedLayerCount === 0,
        disabledReason: noLayers,
        id: "precompose",
        kind: "command",
        label: t("timeline.menu.precompose"),
        onSelect: actions.precompose,
      },
      { id: "switches-separator", kind: "separator" },
      {
        checked: actions.is3d,
        disabled: actions.isAdjustment || actions.locked,
        disabledReason: actions.isAdjustment ? t("timeline.layer.adjustmentNo3d") : locked,
        id: "three-dimensional",
        kind: "checkbox",
        label: t("timeline.menu.threeDimensional"),
        onSelect: actions.toggle3d,
      },
      {
        checked: actions.isAdjustment,
        disabled: true,
        disabledReason: t("timeline.menu.adjustmentUnavailable"),
        id: "adjustment",
        kind: "checkbox",
        label: t("timeline.menu.adjustment"),
        onSelect: () => undefined,
      },
      {
        checked: actions.isMotionBlur,
        disabled: !actions.canMotionBlur || actions.locked,
        disabledReason: actions.locked ? locked : t("timeline.menu.motionBlurUnavailable"),
        id: "motion-blur",
        kind: "checkbox",
        label: t("timeline.menu.motionBlur"),
        onSelect: actions.toggleMotionBlur,
      },
      { id: "source-separator", kind: "separator" },
      {
        disabled: !actions.hasSource,
        disabledReason: t("timeline.menu.noSource"),
        id: "reveal-source",
        kind: "command",
        label: t("timeline.menu.revealSource"),
        onSelect: actions.revealSource,
      },
      {
        id: "open-graph",
        kind: "command",
        label: t("timeline.menu.graphEditor"),
        onSelect: actions.openGraph,
      },
    );
  } else {
    const createKinds: TimelineCreateKind[] = [
      "text",
      "shape",
      "solid",
      "null",
      "audio",
      "adjustment",
      "mesh",
      "camera",
      "light",
      "generator",
    ];
    const createLabels = {
      adjustment: "timeline.menu.new.adjustment",
      audio: "timeline.menu.new.audio",
      camera: "timeline.menu.new.camera",
      generator: "timeline.menu.new.generator",
      light: "timeline.menu.new.light",
      mesh: "timeline.menu.new.mesh",
      null: "timeline.menu.new.null",
      shape: "timeline.menu.new.shape",
      solid: "timeline.menu.new.solid",
      text: "timeline.menu.new.text",
    } as const;
    items.push(
      {
        id: "new-layer",
        kind: "submenu",
        label: t("timeline.menu.new"),
        items: [
          ...createKinds.map((kind) => ({
            id: `new-${kind}`,
            kind: "command" as const,
            label: t(createLabels[kind]),
            onSelect: () => actions.createLayer(kind),
          })),
          {
            disabled: true,
            disabledReason: t("timeline.menu.sourceLayerUnavailable"),
            id: "new-image",
            kind: "command" as const,
            label: t("timeline.menu.new.image"),
            onSelect: () => undefined,
          },
          {
            disabled: true,
            disabledReason: t("timeline.menu.sourceLayerUnavailable"),
            id: "new-video",
            kind: "command" as const,
            label: t("timeline.menu.new.video"),
            onSelect: () => undefined,
          },
          {
            disabled: true,
            disabledReason: t("timeline.menu.sourceLayerUnavailable"),
            id: "new-precomposition",
            kind: "command" as const,
            label: t("timeline.menu.new.precomposition"),
            onSelect: () => undefined,
          },
        ],
      },
      {
        disabled: !actions.canPasteLayers,
        disabledReason: t("timeline.menu.noLayerClipboard"),
        id: "paste-layers",
        kind: "command",
        label: t("timeline.menu.paste"),
        shortcut: "Ctrl/Cmd+V",
        onSelect: actions.pasteLayers,
      },
    );
  }
  items.push(
    { id: "keyframe-separator", kind: "separator" },
    {
      disabled: !actions.canInterpolate,
      disabledReason: !actions.hasKeyframeSelection
        ? t("timeline.menu.noKeyframeSelection")
        : actions.canEditKeyframes
          ? t("timeline.menu.interpolationUnsupported")
          : locked,
      id: "keyframe-interpolation",
      kind: "submenu",
      label: t("timeline.menu.keyframeInterpolation"),
      items: [
        {
          id: "key-linear",
          kind: "command",
          label: t("timeline.menu.linear"),
          onSelect: () => actions.setInterpolation("linear"),
        },
        {
          id: "key-bezier",
          kind: "command",
          label: t("timeline.menu.bezier"),
          onSelect: () => actions.setInterpolation("bezier"),
        },
        {
          id: "key-hold",
          kind: "command",
          label: t("timeline.menu.hold"),
          onSelect: () => actions.setInterpolation("step"),
        },
      ],
    },
    {
      disabled: !actions.hasKeyframeSelection,
      disabledReason: t("timeline.menu.noKeyframeSelection"),
      id: "copy-keyframes",
      kind: "command",
      label: t("timeline.menu.copyKeyframes"),
      onSelect: actions.copyKeyframes,
    },
    {
      disabled: !actions.canPasteKeyframes,
      disabledReason: actions.hasKeyframeClipboard
        ? t("timeline.menu.keyframeTargetUnavailable")
        : t("timeline.menu.noKeyframeClipboard"),
      id: "paste-keyframes",
      kind: "command",
      label: t("timeline.menu.pasteKeyframes"),
      onSelect: actions.pasteKeyframes,
    },
    {
      destructive: true,
      disabled: !actions.canEditKeyframes,
      disabledReason: actions.hasKeyframeSelection
        ? locked
        : t("timeline.menu.noKeyframeSelection"),
      id: "delete-keyframes",
      kind: "command",
      label: t("timeline.menu.deleteKeyframes"),
      onSelect: actions.deleteKeyframes,
    },
  );
  return items;
}

export function TimelineContextMenu(actions: TimelineContextMenuActions) {
  const { t } = useI18n();
  return (
    <ContextMenu
      ariaLabel={t(actions.isLayerTarget ? "timeline.menu.layerLabel" : "timeline.menu.emptyLabel")}
      items={timelineContextMenuItems(actions, t)}
      onClose={actions.onClose}
      open
      x={actions.x}
      y={actions.y}
    />
  );
}
