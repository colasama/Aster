import type { Translate } from "../../i18n/core";
import { useI18n } from "../../i18n/react";
import { ContextMenu } from "../context-menu/ContextMenu";
import type { ContextMenuItem } from "../context-menu/context-menu-model";

export type ProjectContextTarget =
  | { kind: "empty" }
  | { kind: "composition"; id: string; name: string }
  | { kind: "source"; id: string; name: string }
  | { kind: "folder"; id: string; name: string };

export type ProjectImportKind = "image" | "svg" | "psd" | "imageSequence" | "video" | "audio";

export interface ProjectMoveDestination {
  readonly id?: string;
  readonly label: string;
}

export interface ProjectContextMenuActions {
  readonly canAddSourceToComposition: boolean;
  readonly canDelete: boolean;
  readonly canDuplicate: boolean;
  readonly canRelink: boolean;
  readonly canRename: boolean;
  readonly canRevealInComposition: boolean;
  readonly deleteUnavailableReason: string;
  readonly moveDestinations: readonly ProjectMoveDestination[];
  readonly target: ProjectContextTarget;
  readonly x: number;
  readonly y: number;
  addSourceToComposition(): void;
  createComposition(): void;
  createFolder(): void;
  deleteTarget(): void;
  duplicateTarget(): void;
  importAsset(kind: ProjectImportKind): void;
  moveTarget(folderId?: string): void;
  onClose(): void;
  openComposition(): void;
  relinkSource(): void;
  renameTarget(): void;
  revealInComposition(): void;
}

export function projectContextMenuItems(
  actions: ProjectContextMenuActions,
  t: Translate,
): ContextMenuItem[] {
  const importItems: ContextMenuItem[] = (
    ["image", "svg", "psd", "imageSequence", "video", "audio"] as const
  ).map((kind) => ({
    id: `import-${kind}`,
    kind: "command",
    label: t(`project.add.${kind}`),
    onSelect: () => actions.importAsset(kind),
  }));
  const createItems: ContextMenuItem[] = [
    {
      id: "new-composition",
      kind: "command",
      label: t("project.add.composition"),
      onSelect: actions.createComposition,
    },
    {
      id: "new-folder",
      kind: "command",
      label: t("project.add.folder"),
      onSelect: actions.createFolder,
    },
    {
      id: "import",
      kind: "submenu",
      label: t("project.menu.import"),
      items: importItems,
    },
  ];
  if (actions.target.kind === "empty") return createItems;

  const moveItem: ContextMenuItem = {
    disabled: actions.moveDestinations.length === 0,
    disabledReason: t("project.menu.noMoveDestination"),
    id: "move-to",
    kind: "submenu",
    label: t("project.menu.moveTo"),
    items: actions.moveDestinations.map((destination, index) => ({
      id: `move-to-${destination.id ?? `root-${index}`}`,
      kind: "command" as const,
      label: destination.label,
      onSelect: () => actions.moveTarget(destination.id),
    })),
  };
  const editItems: ContextMenuItem[] = [
    {
      disabled: !actions.canRename,
      disabledReason: t("project.menu.renameUnavailable"),
      id: "rename",
      kind: "command",
      label: t("project.menu.rename"),
      shortcut: "F2",
      onSelect: actions.renameTarget,
    },
    ...(actions.target.kind === "composition"
      ? [
          {
            disabled: !actions.canDuplicate,
            disabledReason: t("project.menu.duplicateUnavailable"),
            id: "duplicate",
            kind: "command" as const,
            label: t("project.menu.duplicate"),
            shortcut: "Ctrl/Cmd+D",
            onSelect: actions.duplicateTarget,
          },
        ]
      : []),
    moveItem,
    {
      destructive: true,
      disabled: !actions.canDelete,
      disabledReason: actions.deleteUnavailableReason,
      id: "delete",
      kind: "command",
      label: t("project.menu.delete"),
      shortcut: "Delete",
      onSelect: actions.deleteTarget,
    },
  ];

  if (actions.target.kind === "folder")
    return [...createItems, { id: "folder-edit-separator", kind: "separator" }, ...editItems];
  if (actions.target.kind === "composition")
    return [
      {
        id: "open-composition",
        kind: "command",
        label: t("project.menu.openComposition"),
        onSelect: actions.openComposition,
      },
      { id: "composition-edit-separator", kind: "separator" },
      ...editItems,
    ];
  return [
    {
      disabled: !actions.canAddSourceToComposition,
      disabledReason: t("project.menu.noActiveComposition"),
      id: "add-to-composition",
      kind: "command",
      label: t("project.menu.addToComposition"),
      onSelect: actions.addSourceToComposition,
    },
    {
      disabled: !actions.canRevealInComposition,
      disabledReason: t("project.menu.notUsedInComposition"),
      id: "reveal-in-composition",
      kind: "command",
      label: t("project.menu.revealInComposition"),
      onSelect: actions.revealInComposition,
    },
    {
      disabled: !actions.canRelink,
      disabledReason: t("project.menu.relinkUnavailable"),
      id: "relink",
      kind: "command",
      label: t("project.asset.relink"),
      onSelect: actions.relinkSource,
    },
    { id: "source-edit-separator", kind: "separator" },
    ...editItems,
  ];
}

export function ProjectContextMenu(actions: ProjectContextMenuActions) {
  const { t } = useI18n();
  return (
    <ContextMenu
      ariaLabel={t("project.menu.label")}
      items={projectContextMenuItems(actions, t)}
      onClose={actions.onClose}
      open
      x={actions.x}
      y={actions.y}
    />
  );
}
