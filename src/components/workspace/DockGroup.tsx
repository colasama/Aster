import { ExternalLink, GripVertical, Maximize2, Minimize2, X } from "lucide-react";
import { type DragEvent, type KeyboardEvent, type MouseEvent, useState } from "react";
import type { Translate } from "../../i18n/core";
import { useI18n } from "../../i18n/react";
import { nextTabIndex, type WorkspaceDrag } from "../../workspace/interaction";
import type {
  WorkspaceDockPosition,
  WorkspaceGroupLocation,
  WorkspaceTabGroup,
} from "../../workspace/layout";
import { ContextMenu } from "../context-menu/ContextMenu";
import type { ContextMenuItem } from "../context-menu/context-menu-model";
import { DropZones } from "./DropZones";
import { WorkspacePanelHostContext } from "./WorkspacePanelHost";
import type { WorkspacePanelDefinition } from "./workspace-types";

interface DockGroupProps {
  readonly canUndo: boolean;
  readonly group: WorkspaceTabGroup;
  readonly groups: readonly WorkspaceGroupLocation[];
  readonly panels: ReadonlyMap<string, WorkspacePanelDefinition>;
  readonly drag: WorkspaceDrag | null;
  readonly maximized: boolean;
  readonly onActivate: (groupId: string, panelId: string) => void;
  readonly onClose: (panelId: string) => void;
  readonly onCloseGroup: (groupId: string) => void;
  readonly onCloseOthers: (groupId: string, panelId: string) => void;
  readonly onDockGroup: (groupId: string) => void;
  readonly onDockPanel: (panelId: string) => void;
  readonly onDragChange: (drag: WorkspaceDrag | null) => void;
  readonly onDrop: (
    drag: WorkspaceDrag,
    targetGroupId: string,
    position: WorkspaceDockPosition,
  ) => void;
  readonly onFloat: (groupId: string, bounds: DOMRect) => void;
  readonly onFloatPanel: (panelId: string, bounds: DOMRect) => void;
  readonly onHover: (groupId: string) => void;
  readonly onMaximize: (groupId: string) => void;
  readonly onMoveGroup: (
    sourceGroupId: string,
    targetGroupId: string,
    position: WorkspaceDockPosition,
  ) => void;
  readonly onMovePanel: (
    panelId: string,
    targetGroupId: string,
    position: WorkspaceDockPosition,
  ) => void;
  readonly onUndo: () => void;
}

export function DockGroup({
  canUndo,
  group,
  groups,
  panels,
  drag,
  maximized,
  onActivate,
  onClose,
  onCloseGroup,
  onCloseOthers,
  onDockGroup,
  onDockPanel,
  onDragChange,
  onDrop,
  onFloat,
  onFloatPanel,
  onHover,
  onMaximize,
  onMoveGroup,
  onMovePanel,
  onUndo,
}: DockGroupProps) {
  const { t } = useI18n();
  const [headerHost, setHeaderHost] = useState<HTMLDivElement | null>(null);
  const [contextMenu, setContextMenu] = useState<{
    readonly kind: "group" | "panel";
    readonly panelId?: string;
    readonly x: number;
    readonly y: number;
    readonly bounds: DOMRect;
  }>();
  const active = panels.get(group.activePanelId);
  const location = groups.find((candidate) => candidate.group.id === group.id);
  const floating = Boolean(location?.floatingId);
  const openContextMenu = (event: MouseEvent, kind: "group" | "panel", panelId?: string) => {
    event.preventDefault();
    event.stopPropagation();
    setContextMenu({
      kind,
      panelId,
      x: event.clientX,
      y: event.clientY,
      bounds:
        event.currentTarget.closest("section")?.getBoundingClientRect() ??
        new DOMRect(120, 90, 620, 420),
    });
  };
  const startDrag = (event: DragEvent, value: WorkspaceDrag) => {
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData(
      "text/plain",
      value.kind === "panel" ? value.panelId : value.groupId,
    );
    onDragChange(value);
  };
  const onTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>, panelId: string) => {
    if (
      event.key !== "ArrowLeft" &&
      event.key !== "ArrowRight" &&
      event.key !== "Home" &&
      event.key !== "End"
    )
      return;
    event.preventDefault();
    const current = group.panels.indexOf(panelId);
    const next = nextTabIndex(current, group.panels.length, event.key);
    const nextPanel = group.panels[next];
    if (!nextPanel) return;
    onActivate(group.id, nextPanel);
    const tabList = event.currentTarget.parentElement;
    queueMicrotask(() =>
      (tabList?.querySelectorAll<HTMLButtonElement>("[role=tab]")[next] ?? null)?.focus(),
    );
  };
  return (
    <section
      className={`workspace-group ${maximized ? "maximized" : ""}`}
      data-workspace-group={group.id}
      onPointerEnter={() => onHover(group.id)}
    >
      {/* biome-ignore lint/a11y/noStaticElementInteractions: The header supports AE-style double-click group maximize. */}
      <header
        className="workspace-group-header"
        onDoubleClick={(event) => {
          if (!(event.target as HTMLElement).closest("button")) onMaximize(group.id);
        }}
        onContextMenu={(event) => openContextMenu(event, "group")}
      >
        <button
          aria-label={t("workspace.dragGroup")}
          className="workspace-group-grip"
          draggable
          onDragEnd={() => onDragChange(null)}
          onDragStart={(event) => startDrag(event, { kind: "group", groupId: group.id })}
          title={t("workspace.dragGroup")}
          type="button"
        >
          <GripVertical size={12} />
        </button>
        <div aria-label={t("workspace.panelTabs")} className="workspace-tabs" role="tablist">
          {group.panels.map((panelId) => {
            const panel = panels.get(panelId);
            if (!panel) return null;
            const selected = panelId === group.activePanelId;
            return (
              <button
                aria-selected={selected}
                className={selected ? "active" : ""}
                draggable
                key={panelId}
                onClick={() => onActivate(group.id, panelId)}
                onDragEnd={() => onDragChange(null)}
                onDragStart={(event) => startDrag(event, { kind: "panel", panelId })}
                onKeyDown={(event) => onTabKeyDown(event, panelId)}
                onContextMenu={(event) => openContextMenu(event, "panel", panelId)}
                role="tab"
                tabIndex={selected ? 0 : -1}
                title={panel.label}
                type="button"
              >
                {panel.label}
              </button>
            );
          })}
        </div>
        <div className="workspace-panel-header-host" ref={setHeaderHost} />
        <div className="workspace-group-actions">
          <button
            aria-label={floating ? t("workspace.dockGroup") : t("workspace.floatGroup")}
            onClick={(event) => {
              if (floating) onDockGroup(group.id);
              else
                onFloat(
                  group.id,
                  event.currentTarget.closest("section")?.getBoundingClientRect() ??
                    new DOMRect(120, 90, 620, 420),
                );
            }}
            title={floating ? t("workspace.dockGroup") : t("workspace.floatGroup")}
            type="button"
          >
            <ExternalLink size={12} />
          </button>
          <button
            aria-label={maximized ? t("workspace.restoreGroup") : t("workspace.maximizeGroup")}
            onClick={() => onMaximize(group.id)}
            title={maximized ? t("workspace.restoreGroup") : t("workspace.maximizeGroup")}
            type="button"
          >
            {maximized ? <Minimize2 size={12} /> : <Maximize2 size={12} />}
          </button>
          <button
            aria-label={t("workspace.closePanel", { panel: active?.label ?? group.activePanelId })}
            onClick={() => onClose(group.activePanelId)}
            title={t("workspace.closePanel", { panel: active?.label ?? group.activePanelId })}
            type="button"
          >
            <X size={12} />
          </button>
        </div>
      </header>
      <div className="workspace-group-content" role="tabpanel">
        {active ? (
          <WorkspacePanelHostContext.Provider value={{ headerHost }}>
            {active.element}
          </WorkspacePanelHostContext.Provider>
        ) : null}
      </div>
      {drag ? <DropZones onDrop={(position) => onDrop(drag, group.id, position)} /> : null}
      <ContextMenu
        ariaLabel={t("workspace.contextMenu")}
        items={
          contextMenu
            ? workspaceContextMenuItems({
                bounds: contextMenu.bounds,
                canUndo,
                floating,
                group,
                groups,
                kind: contextMenu.kind,
                maximized,
                onClose,
                onCloseGroup,
                onCloseOthers,
                onDockGroup,
                onDockPanel,
                onFloat,
                onFloatPanel,
                onMaximize,
                onMoveGroup,
                onMovePanel,
                onUndo,
                panelId: contextMenu.panelId,
                panels,
                t,
              })
            : []
        }
        onClose={() => setContextMenu(undefined)}
        open={Boolean(contextMenu)}
        x={contextMenu?.x ?? 0}
        y={contextMenu?.y ?? 0}
      />
    </section>
  );
}

interface WorkspaceContextMenuOptions {
  readonly bounds: DOMRect;
  readonly canUndo: boolean;
  readonly floating: boolean;
  readonly group: WorkspaceTabGroup;
  readonly groups: readonly WorkspaceGroupLocation[];
  readonly kind: "group" | "panel";
  readonly maximized: boolean;
  readonly panelId?: string;
  readonly panels: ReadonlyMap<string, WorkspacePanelDefinition>;
  readonly t: Translate;
  readonly onClose: (panelId: string) => void;
  readonly onCloseGroup: (groupId: string) => void;
  readonly onCloseOthers: (groupId: string, panelId: string) => void;
  readonly onDockGroup: (groupId: string) => void;
  readonly onDockPanel: (panelId: string) => void;
  readonly onFloat: (groupId: string, bounds: DOMRect) => void;
  readonly onFloatPanel: (panelId: string, bounds: DOMRect) => void;
  readonly onMaximize: (groupId: string) => void;
  readonly onMoveGroup: (
    sourceGroupId: string,
    targetGroupId: string,
    position: WorkspaceDockPosition,
  ) => void;
  readonly onMovePanel: (
    panelId: string,
    targetGroupId: string,
    position: WorkspaceDockPosition,
  ) => void;
  readonly onUndo: () => void;
}

function workspaceContextMenuItems(options: WorkspaceContextMenuOptions): ContextMenuItem[] {
  const { bounds, canUndo, floating, group, groups, kind, maximized, panelId, panels, t } = options;
  const otherGroups = groups.filter((candidate) => candidate.group.id !== group.id);
  const panelMoveItems: ContextMenuItem[] = otherGroups.map((candidate) => ({
    id: `move-panel-${candidate.group.id}`,
    kind: "command",
    label: groupLabel(candidate.group, panels),
    onSelect: () => panelId && options.onMovePanel(panelId, candidate.group.id, "center"),
  }));
  const groupMoveItems: ContextMenuItem[] = otherGroups.map((candidate) => ({
    id: `move-group-${candidate.group.id}`,
    kind: "command",
    label: groupLabel(candidate.group, panels),
    onSelect: () => options.onMoveGroup(group.id, candidate.group.id, "center"),
  }));
  const positions: readonly Exclude<WorkspaceDockPosition, "center">[] = [
    "left",
    "right",
    "top",
    "bottom",
  ];
  const panelSplitItems: ContextMenuItem[] = positions.map((position) => ({
    id: `split-panel-${position}`,
    kind: "command",
    label: t(`workspace.move.${position}`),
    disabled: group.panels.length <= 1,
    onSelect: () => panelId && options.onMovePanel(panelId, group.id, position),
  }));
  const groupSplitItems: ContextMenuItem[] = otherGroups.flatMap((candidate) =>
    positions.map((position) => ({
      id: `split-group-${candidate.group.id}-${position}`,
      kind: "command" as const,
      label: t("workspace.move.relative", {
        position: t(`workspace.move.${position}`),
        group: groupLabel(candidate.group, panels),
      }),
      onSelect: () => options.onMoveGroup(group.id, candidate.group.id, position),
    })),
  );
  const items: ContextMenuItem[] = [];
  if (kind === "panel" && panelId) {
    items.push(
      {
        id: "close-panel",
        kind: "command",
        label: t("workspace.menu.close"),
        destructive: true,
        onSelect: () => options.onClose(panelId),
      },
      {
        id: "close-others",
        kind: "command",
        label: t("workspace.menu.closeOthers"),
        disabled: group.panels.length <= 1,
        destructive: true,
        onSelect: () => options.onCloseOthers(group.id, panelId),
      },
    );
  }
  items.push(
    {
      id: "close-group",
      kind: "command",
      label: t("workspace.menu.closeGroup"),
      destructive: true,
      onSelect: () => options.onCloseGroup(group.id),
    },
    { id: "separator-layout", kind: "separator" },
    {
      id: floating ? "dock" : "float",
      kind: "command",
      label: floating ? t("workspace.menu.dock") : t("workspace.menu.float"),
      onSelect: () => {
        if (kind === "panel" && panelId) {
          if (floating) options.onDockPanel(panelId);
          else options.onFloatPanel(panelId, bounds);
        } else if (floating) options.onDockGroup(group.id);
        else options.onFloat(group.id, bounds);
      },
    },
    {
      id: "maximize",
      kind: "command",
      label: maximized ? t("workspace.restoreGroup") : t("workspace.maximizeGroup"),
      onSelect: () => options.onMaximize(group.id),
    },
    {
      id: "move-group",
      kind: "submenu",
      label: t("workspace.menu.moveToGroup"),
      disabled: otherGroups.length === 0,
      items: kind === "panel" ? panelMoveItems : groupMoveItems,
    },
    {
      id: "move-split",
      kind: "submenu",
      label: t("workspace.menu.moveToSplit"),
      disabled: kind === "panel" ? group.panels.length <= 1 : groupSplitItems.length === 0,
      items: kind === "panel" ? panelSplitItems : groupSplitItems,
    },
    { id: "separator-undo", kind: "separator" },
    {
      id: "undo-layout",
      kind: "command",
      label: t("workspace.menu.undo"),
      disabled: !canUndo,
      shortcut: "Ctrl Alt Z",
      onSelect: options.onUndo,
    },
  );
  return items;
}

function groupLabel(
  group: WorkspaceTabGroup,
  panels: ReadonlyMap<string, WorkspacePanelDefinition>,
): string {
  return group.panels.map((panelId) => panels.get(panelId)?.label ?? panelId).join(" / ");
}
