import type { Translate } from "../i18n/core";
import { useI18n } from "../i18n/react";
import { ContextMenu } from "./context-menu/ContextMenu";
import type { ContextMenuItem } from "./context-menu/context-menu-model";
import type { GraphType } from "./graph-editor/model";

export interface GraphContextMenuActions {
  canEdit: boolean;
  canPaste: boolean;
  copy(): void;
  delete(): void;
  disabledReason: string;
  easyEase(): void;
  fitAll(): void;
  fitSelection(): void;
  graphType: GraphType;
  hasClipboard: boolean;
  hasSelection: boolean;
  hasTracks: boolean;
  onClose(): void;
  paste(): void;
  setGraphType(value: GraphType): void;
  setInterpolation(value: "linear" | "bezier" | "step"): void;
  x: number;
  y: number;
}

export function graphContextMenuItems(
  actions: GraphContextMenuActions,
  t: Translate,
): ContextMenuItem[] {
  const selectionUnavailable = actions.hasSelection
    ? actions.disabledReason
    : t("graph.menu.noSelection");
  return [
    {
      id: "graph-type",
      kind: "submenu",
      label: t("graph.type.label"),
      items: (["value", "speed"] as const).map((type) => ({
        checked: actions.graphType === type,
        group: "graph-type",
        id: `graph-${type}`,
        kind: "radio" as const,
        label: t(type === "value" ? "graph.type.value" : "graph.type.speed"),
        onSelect: () => actions.setGraphType(type),
      })),
    },
    {
      disabled: !actions.hasSelection,
      disabledReason: t("graph.menu.noSelection"),
      id: "fit-selection",
      kind: "command",
      label: t("graph.fitSelection"),
      onSelect: actions.fitSelection,
    },
    {
      disabled: !actions.hasTracks,
      disabledReason: t("graph.menu.noTracks"),
      id: "fit-all",
      kind: "command",
      label: t("graph.fitAll"),
      onSelect: actions.fitAll,
    },
    { id: "edit-separator", kind: "separator" },
    {
      disabled: !actions.canEdit,
      disabledReason: selectionUnavailable,
      id: "interpolation",
      kind: "submenu",
      label: t("graph.menu.interpolation"),
      items: [
        {
          id: "linear",
          kind: "command",
          label: t("graph.menu.linear"),
          onSelect: () => actions.setInterpolation("linear"),
        },
        {
          id: "bezier",
          kind: "command",
          label: t("graph.menu.bezier"),
          onSelect: () => actions.setInterpolation("bezier"),
        },
        {
          id: "hold",
          kind: "command",
          label: t("graph.menu.hold"),
          onSelect: () => actions.setInterpolation("step"),
        },
      ],
    },
    {
      disabled: !actions.canEdit,
      disabledReason: selectionUnavailable,
      id: "easy-ease",
      kind: "command",
      label: t("graph.menu.easyEase"),
      shortcut: "F9",
      onSelect: actions.easyEase,
    },
    { id: "clipboard-separator", kind: "separator" },
    {
      disabled: !actions.hasSelection,
      disabledReason: t("graph.menu.noSelection"),
      id: "copy",
      kind: "command",
      label: t("graph.menu.copy"),
      shortcut: "Ctrl/Cmd+C",
      onSelect: actions.copy,
    },
    {
      disabled: !actions.canPaste,
      disabledReason: actions.hasClipboard
        ? t("graph.menu.pasteTargetUnavailable")
        : t("graph.menu.noClipboard"),
      id: "paste",
      kind: "command",
      label: t("graph.menu.paste"),
      shortcut: "Ctrl/Cmd+V",
      onSelect: actions.paste,
    },
    {
      destructive: true,
      disabled: !actions.canEdit,
      disabledReason: selectionUnavailable,
      id: "delete",
      kind: "command",
      label: t("graph.menu.delete"),
      onSelect: actions.delete,
    },
  ];
}

export function GraphContextMenu(actions: GraphContextMenuActions) {
  const { t } = useI18n();
  return (
    <ContextMenu
      ariaLabel={t("graph.menu.label")}
      items={graphContextMenuItems(actions, t)}
      onClose={actions.onClose}
      open
      x={actions.x}
      y={actions.y}
    />
  );
}
