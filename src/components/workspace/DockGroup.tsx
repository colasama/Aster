import { ExternalLink, GripVertical, Maximize2, Minimize2, X } from "lucide-react";
import { type DragEvent, type KeyboardEvent, useState } from "react";
import { useI18n } from "../../i18n/react";
import { nextTabIndex, type WorkspaceDrag } from "../../workspace/interaction";
import type { WorkspaceDockPosition, WorkspaceTabGroup } from "../../workspace/layout";
import { DropZones } from "./DropZones";
import { WorkspacePanelHostContext } from "./WorkspacePanelHost";
import type { WorkspacePanelDefinition } from "./workspace-types";

interface DockGroupProps {
  readonly group: WorkspaceTabGroup;
  readonly panels: ReadonlyMap<string, WorkspacePanelDefinition>;
  readonly drag: WorkspaceDrag | null;
  readonly maximized: boolean;
  readonly onActivate: (groupId: string, panelId: string) => void;
  readonly onClose: (panelId: string) => void;
  readonly onDragChange: (drag: WorkspaceDrag | null) => void;
  readonly onDrop: (
    drag: WorkspaceDrag,
    targetGroupId: string,
    position: WorkspaceDockPosition,
  ) => void;
  readonly onFloat: (groupId: string, bounds: DOMRect) => void;
  readonly onHover: (groupId: string) => void;
  readonly onMaximize: (groupId: string) => void;
}

export function DockGroup({
  group,
  panels,
  drag,
  maximized,
  onActivate,
  onClose,
  onDragChange,
  onDrop,
  onFloat,
  onHover,
  onMaximize,
}: DockGroupProps) {
  const { t } = useI18n();
  const [headerHost, setHeaderHost] = useState<HTMLDivElement | null>(null);
  const active = panels.get(group.activePanelId);
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
            aria-label={t("workspace.floatGroup")}
            onClick={(event) =>
              onFloat(
                group.id,
                event.currentTarget.closest("section")?.getBoundingClientRect() ??
                  new DOMRect(120, 90, 620, 420),
              )
            }
            title={t("workspace.floatGroup")}
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
    </section>
  );
}
