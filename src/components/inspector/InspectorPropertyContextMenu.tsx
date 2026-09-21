import type { Translate } from "../../i18n/core";
import { useI18n } from "../../i18n/react";
import { ContextMenu } from "../context-menu/ContextMenu";
import type { ContextMenuItem } from "../context-menu/context-menu-model";

export interface InspectorPropertyContextMenuActions {
  addKeyframe(): void;
  canEdit: boolean;
  canCopy?: boolean;
  canPaste: boolean;
  copy(): void;
  disabledReason: string;
  hasKeyframe: boolean;
  label: string;
  onClose(): void;
  paste(): void;
  removeKeyframe(): void;
  reset(): void;
  revealInTimeline(): void;
  x: number;
  y: number;
}

export function inspectorPropertyContextMenuItems(
  actions: InspectorPropertyContextMenuActions,
  t: Translate,
): ContextMenuItem[] {
  return [
    {
      disabled: !actions.canEdit,
      disabledReason: actions.disabledReason,
      id: "reset",
      kind: "command",
      label: t("inspector.menu.reset"),
      onSelect: actions.reset,
    },
    { id: "value-separator", kind: "separator" },
    {
      id: "copy",
      kind: "command",
      label: t("inspector.menu.copy"),
      onSelect: actions.copy,
      disabled: actions.canCopy === false,
      disabledReason: t("inspector.mixed"),
    },
    {
      disabled: !actions.canPaste || !actions.canEdit,
      disabledReason: actions.canEdit ? t("inspector.menu.noClipboard") : actions.disabledReason,
      id: "paste",
      kind: "command",
      label: t("inspector.menu.paste"),
      onSelect: actions.paste,
    },
    { id: "keyframe-separator", kind: "separator" },
    {
      disabled: !actions.canEdit,
      disabledReason: actions.disabledReason,
      id: actions.hasKeyframe ? "remove-keyframe" : "add-keyframe",
      kind: "command",
      label: t(
        actions.hasKeyframe ? "inspector.menu.removeKeyframe" : "inspector.menu.addKeyframe",
      ),
      onSelect: actions.hasKeyframe ? actions.removeKeyframe : actions.addKeyframe,
    },
    {
      id: "reveal",
      kind: "command",
      label: t("inspector.menu.revealTimeline"),
      onSelect: actions.revealInTimeline,
    },
  ];
}

export function InspectorPropertyContextMenu(actions: InspectorPropertyContextMenuActions) {
  const { t } = useI18n();
  return (
    <ContextMenu
      ariaLabel={t("inspector.menu.label", { property: actions.label })}
      items={inspectorPropertyContextMenuItems(actions, t)}
      onClose={actions.onClose}
      open
      x={actions.x}
      y={actions.y}
    />
  );
}
