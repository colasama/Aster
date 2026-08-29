import { ChevronDown, ChevronRight, X } from "lucide-react";
import { type DragEvent, type MouseEvent, useState } from "react";
import { useI18n } from "../../i18n/react";
import type { WorkspaceDrag } from "../../workspace/interaction";
import type { WorkspaceTabGroup } from "../../workspace/layout";
import { WorkspacePanelHostContext } from "./WorkspacePanelHost";
import type { WorkspacePanelDefinition } from "./workspace-types";

export function StackedPanelGroup({
  group,
  panels,
  onActivate,
  onClose,
  onContextMenu,
  onDragChange,
  onToggle,
}: {
  readonly group: WorkspaceTabGroup;
  readonly panels: ReadonlyMap<string, WorkspacePanelDefinition>;
  readonly onActivate: (panelId: string) => void;
  readonly onClose: (panelId: string) => void;
  readonly onContextMenu: (event: MouseEvent, panelId: string) => void;
  readonly onDragChange: (drag: WorkspaceDrag | null) => void;
  readonly onToggle: (panelId: string, simultaneous: boolean, toggleSolo: boolean) => void;
}) {
  const expanded = new Set(group.expandedPanelIds ?? []);
  return (
    <div className="workspace-stack">
      {group.panels.map((panelId) => {
        const panel = panels.get(panelId);
        if (!panel) return null;
        return (
          <StackedPanel
            expanded={expanded.has(panelId)}
            key={panelId}
            onActivate={() => onActivate(panelId)}
            onClose={() => onClose(panelId)}
            onContextMenu={(event) => onContextMenu(event, panelId)}
            onDragChange={onDragChange}
            onToggle={(simultaneous, toggleSolo) => onToggle(panelId, simultaneous, toggleSolo)}
            panel={panel}
            selected={group.activePanelId === panelId}
          />
        );
      })}
    </div>
  );
}

function StackedPanel({
  expanded,
  onActivate,
  onClose,
  onContextMenu,
  onDragChange,
  onToggle,
  panel,
  selected,
}: {
  readonly expanded: boolean;
  readonly onActivate: () => void;
  readonly onClose: () => void;
  readonly onContextMenu: (event: MouseEvent) => void;
  readonly onDragChange: (drag: WorkspaceDrag | null) => void;
  readonly onToggle: (simultaneous: boolean, toggleSolo: boolean) => void;
  readonly panel: WorkspacePanelDefinition;
  readonly selected: boolean;
}) {
  const { t } = useI18n();
  const [headerHost, setHeaderHost] = useState<HTMLDivElement | null>(null);
  const contentId = `workspace-stack-${domId(panel.id)}`;
  const startDrag = (event: DragEvent<HTMLButtonElement>) => {
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", panel.id);
    onDragChange({ kind: "panel", panelId: panel.id });
  };
  return (
    <section
      className={`workspace-stack-panel ${selected ? "active" : ""}`}
      data-expanded={expanded ? "true" : undefined}
    >
      {/* biome-ignore lint/a11y/noStaticElementInteractions: AE exposes the panel menu across the complete stacked header. */}
      <header className="workspace-stack-header" onContextMenu={onContextMenu}>
        <button
          aria-controls={contentId}
          aria-expanded={expanded}
          className="workspace-stack-toggle"
          draggable
          onClick={(event) => {
            onActivate();
            onToggle(event.ctrlKey || event.metaKey, event.altKey);
          }}
          onDragEnd={() => onDragChange(null)}
          onDragStart={startDrag}
          type="button"
        >
          {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          <span className="workspace-stack-label">{panel.label}</span>
        </button>
        <div className="workspace-panel-header-host" ref={setHeaderHost} />
        <button
          aria-label={t("workspace.closePanel", { panel: panel.label })}
          className="workspace-stack-close"
          onClick={onClose}
          title={t("workspace.closePanel", { panel: panel.label })}
          type="button"
        >
          <X size={11} />
        </button>
      </header>
      {expanded ? (
        <section className="workspace-stack-content" id={contentId}>
          <WorkspacePanelHostContext.Provider value={{ headerHost }}>
            {panel.element}
          </WorkspacePanelHostContext.Provider>
        </section>
      ) : null}
    </section>
  );
}

function domId(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "-");
}
