import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { DEFAULT_WORKSPACE_LAYOUT } from "../../workspace/default-layout";
import { applyWorkspaceDrop, type WorkspaceDrag } from "../../workspace/interaction";
import {
  activatePanel,
  closePanel,
  findWorkspaceNode,
  floatGroup,
  reopenPanel,
  resizeSplit,
  setFloatingBounds,
  type WorkspaceDockPosition,
  type WorkspaceLayout,
} from "../../workspace/layout";
import { loadWorkspaceLayout, saveWorkspaceLayout } from "../../workspace/layout-storage";
import { DockNode } from "./DockNode";
import { FloatingWorkspaceFrame } from "./FloatingWorkspaceFrame";
import type { WorkspacePanelDefinition } from "./workspace-types";

export interface WorkspaceApi {
  readonly closedPanelIds: readonly string[];
  close(panelId: string): void;
  reopen(panelId: string, targetGroupId?: string, position?: WorkspaceDockPosition): void;
}

const WorkspaceApiContext = createContext<WorkspaceApi | null>(null);

export function useWorkspaceApi(): WorkspaceApi {
  const value = useContext(WorkspaceApiContext);
  if (!value) throw new Error("useWorkspaceApi must be used inside DockWorkspace");
  return value;
}

export function DockWorkspace({
  panels,
  initialLayout = DEFAULT_WORKSPACE_LAYOUT,
}: {
  readonly panels: readonly WorkspacePanelDefinition[];
  readonly initialLayout?: WorkspaceLayout;
}) {
  const panelMap = useMemo(() => new Map(panels.map((panel) => [panel.id, panel])), [panels]);
  const [layout, setLayout] = useState(() => loadWorkspaceLayout(initialLayout));
  const [drag, setDrag] = useState<WorkspaceDrag | null>(null);
  const [hoveredGroupId, setHoveredGroupId] = useState<string | null>(null);
  const [maximizedGroupId, setMaximizedGroupId] = useState<string | null>(null);
  const hoveredGroupRef = useRef<string | null>(null);
  hoveredGroupRef.current = hoveredGroupId;

  const commit = useCallback((update: (current: WorkspaceLayout) => WorkspaceLayout) => {
    setLayout((current) => {
      const next = update(current);
      if (next !== current) saveWorkspaceLayout(next);
      return next;
    });
  }, []);
  const toggleMaximize = useCallback((groupId: string) => {
    setMaximizedGroupId((current) => (current === groupId ? null : groupId));
  }, []);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.matches("input, textarea, [contenteditable=true]")) return;
      if (event.code !== "Backquote" || event.ctrlKey || event.metaKey || event.altKey) return;
      const groupId = hoveredGroupRef.current;
      if (!groupId) return;
      event.preventDefault();
      toggleMaximize(groupId);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [toggleMaximize]);

  const close = useCallback(
    (panelId: string) => {
      commit((current) => closePanel(current, panelId));
      setMaximizedGroupId(null);
    },
    [commit],
  );
  const reopen = useCallback(
    (panelId: string, targetGroupId?: string, position?: WorkspaceDockPosition) =>
      commit((current) =>
        reopenPanel(
          current,
          panelId,
          targetGroupId ?? hoveredGroupRef.current ?? undefined,
          position,
        ),
      ),
    [commit],
  );
  const api = useMemo<WorkspaceApi>(
    () => ({ closedPanelIds: layout.closedPanels, close, reopen }),
    [close, layout.closedPanels, reopen],
  );
  const common = {
    panels: panelMap,
    drag,
    maximizedGroupId,
    onActivate: (groupId: string, panelId: string) =>
      commit((current) => activatePanel(current, groupId, panelId)),
    onClose: close,
    onDragChange: setDrag,
    onDrop: (value: WorkspaceDrag, targetGroupId: string, position: WorkspaceDockPosition) => {
      commit((current) => applyWorkspaceDrop(current, value, targetGroupId, position));
      setDrag(null);
    },
    onFloat: (groupId: string, bounds: DOMRect) => {
      commit((current) =>
        floatGroup(current, groupId, {
          x: Math.max(8, bounds.x),
          y: Math.max(40, bounds.y),
          width: Math.max(300, bounds.width),
          height: Math.max(180, bounds.height),
        }),
      );
      setMaximizedGroupId(null);
    },
    onHover: setHoveredGroupId,
    onMaximize: toggleMaximize,
    onResize: (splitId: string, ratio: number) =>
      commit((current) => resizeSplit(current, splitId, ratio)),
  } as const;
  const maximizedNode = maximizedGroupId ? findWorkspaceNode(layout, maximizedGroupId) : undefined;
  const renderedRoot = maximizedNode ?? layout.root;
  return (
    <WorkspaceApiContext.Provider value={api}>
      <div
        className="editor-grid workspace-root"
        data-maximized={maximizedNode ? "true" : undefined}
      >
        {renderedRoot ? <DockNode {...common} node={renderedRoot} /> : <EmptyWorkspace />}
        {!maximizedNode
          ? layout.floating.map((entry) => (
              <FloatingWorkspaceFrame
                {...common}
                entry={entry}
                key={entry.id}
                onMove={(floatingId, bounds) =>
                  commit((current) => setFloatingBounds(current, floatingId, bounds))
                }
              />
            ))
          : null}
      </div>
    </WorkspaceApiContext.Provider>
  );
}

function EmptyWorkspace(): ReactNode {
  return <div className="workspace-empty" />;
}
