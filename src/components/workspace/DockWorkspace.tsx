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
  closeGroup,
  closeOtherPanels,
  closePanel,
  dockGroup,
  dockGroupToRoot,
  dockPanel,
  dockPanelToRoot,
  findWorkspaceNode,
  floatGroup,
  floatPanel,
  movePanelToTabSlot,
  reopenPanel,
  resizeSplit,
  setFloatingBounds,
  type WorkspaceDockPosition,
  type WorkspaceLayout,
  workspacePanelIds,
  workspaceTabGroups,
} from "../../workspace/layout";
import { loadWorkspaceLayout, saveWorkspaceLayout } from "../../workspace/layout-storage";
import {
  deleteWorkspace,
  loadWorkspaceCatalog,
  renameWorkspace,
  saveWorkspaceAs,
  saveWorkspaceCatalog,
  selectWorkspace,
  workspaceById,
} from "../../workspace/named-workspaces";
import {
  registerWorkspaceController,
  type WorkspaceController,
} from "../../workspace/workspace-controller";
import { DockNode } from "./DockNode";
import { FloatingWorkspaceFrame } from "./FloatingWorkspaceFrame";
import type { WorkspacePanelDefinition } from "./workspace-types";

export interface WorkspaceApi {
  readonly canUndo: boolean;
  readonly closedPanelIds: readonly string[];
  close(panelId: string): void;
  reopen(panelId: string, targetGroupId?: string, position?: WorkspaceDockPosition): void;
  undoLayoutChange(): void;
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
  const [catalog, setCatalog] = useState(loadWorkspaceCatalog);
  const [layout, setLayout] = useState(() => {
    const restoredCatalog = loadWorkspaceCatalog();
    const saved = workspaceById(restoredCatalog, restoredCatalog.currentWorkspaceId)?.layout;
    return loadWorkspaceLayout(
      initialLayout === DEFAULT_WORKSPACE_LAYOUT ? (saved ?? initialLayout) : initialLayout,
    );
  });
  const [drag, setDrag] = useState<WorkspaceDrag | null>(null);
  const [hoveredGroupId, setHoveredGroupId] = useState<string | null>(null);
  const [maximizedGroupId, setMaximizedGroupId] = useState<string | null>(null);
  const [activeFloatingId, setActiveFloatingId] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const layoutHistory = useRef<WorkspaceLayout[]>([]);
  const hoveredGroupRef = useRef<string | null>(null);
  hoveredGroupRef.current = hoveredGroupId;

  const commit = useCallback((update: (current: WorkspaceLayout) => WorkspaceLayout) => {
    setLayout((current) => {
      const next = update(current);
      if (next !== current) {
        layoutHistory.current = [...layoutHistory.current.slice(-29), current];
        saveWorkspaceLayout(next);
      }
      return next;
    });
  }, []);
  const undoLayoutChange = useCallback(() => {
    const previous = layoutHistory.current[layoutHistory.current.length - 1];
    if (!previous) return;
    layoutHistory.current = layoutHistory.current.slice(0, -1);
    setLayout(previous);
    saveWorkspaceLayout(previous);
    setMaximizedGroupId(null);
  }, []);
  const toggleMaximize = useCallback((groupId: string) => {
    setMaximizedGroupId((current) => (current === groupId ? null : groupId));
  }, []);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target instanceof Element && target.matches("input, textarea, [contenteditable=true]"))
        return;
      if ((event.ctrlKey || event.metaKey) && event.altKey && event.key.toLowerCase() === "z") {
        event.preventDefault();
        undoLayoutChange();
        return;
      }
      if ((event.ctrlKey || event.metaKey) && event.key === "F6") {
        const tabs = [
          ...(rootRef.current?.querySelectorAll<HTMLButtonElement>(
            '[role="tab"][aria-selected="true"]',
          ) ?? []),
        ];
        if (tabs.length === 0) return;
        event.preventDefault();
        const currentGroup = (document.activeElement as HTMLElement | null)?.closest(
          ".workspace-group",
        );
        const currentIndex = tabs.findIndex(
          (tab) => tab.closest(".workspace-group") === currentGroup,
        );
        const direction = event.shiftKey ? -1 : 1;
        const origin = currentIndex < 0 ? (event.shiftKey ? 0 : -1) : currentIndex;
        const nextIndex = (origin + direction + tabs.length) % tabs.length;
        tabs[nextIndex]?.focus();
        return;
      }
      if (event.code !== "Backquote" || event.ctrlKey || event.metaKey || event.altKey) return;
      const groupId = hoveredGroupRef.current;
      if (!groupId) return;
      event.preventDefault();
      toggleMaximize(groupId);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [toggleMaximize, undoLayoutChange]);

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
  const selectNamedWorkspace = useCallback(
    (workspaceId: string) => {
      const workspace = workspaceById(catalog, workspaceId);
      if (!workspace || workspaceId === catalog.currentWorkspaceId) return;
      const nextCatalog = selectWorkspace(catalog, workspaceId);
      setCatalog(nextCatalog);
      saveWorkspaceCatalog(nextCatalog);
      layoutHistory.current = [];
      setLayout(workspace.layout);
      saveWorkspaceLayout(workspace.layout);
      setMaximizedGroupId(null);
    },
    [catalog],
  );
  const saveAsNamedWorkspace = useCallback(
    (name: string) => {
      const next = saveWorkspaceAs(catalog, name, layout);
      setCatalog(next);
      saveWorkspaceCatalog(next);
    },
    [catalog, layout],
  );
  const renameCurrentWorkspace = useCallback(
    (name: string) => {
      const next = renameWorkspace(catalog, catalog.currentWorkspaceId, name);
      if (next === catalog) return;
      setCatalog(next);
      saveWorkspaceCatalog(next);
    },
    [catalog],
  );
  const deleteCurrentWorkspace = useCallback(() => {
    const next = deleteWorkspace(catalog, catalog.currentWorkspaceId);
    if (next === catalog) return;
    const nextWorkspace = workspaceById(next, next.currentWorkspaceId);
    setCatalog(next);
    saveWorkspaceCatalog(next);
    if (nextWorkspace) {
      layoutHistory.current = [];
      setLayout(nextWorkspace.layout);
      saveWorkspaceLayout(nextWorkspace.layout);
    }
    setMaximizedGroupId(null);
  }, [catalog]);
  const resetToSavedLayout = useCallback(() => {
    const workspace = workspaceById(catalog, catalog.currentWorkspaceId);
    if (workspace) commit(() => workspace.layout);
    setMaximizedGroupId(null);
  }, [catalog, commit]);
  const visiblePanelIds = useMemo(() => new Set(workspacePanelIds(layout)), [layout]);
  const currentWorkspace =
    workspaceById(catalog, catalog.currentWorkspaceId) ?? catalog.workspaces[0];
  if (!currentWorkspace) throw new Error("Workspace catalog must contain a built-in workspace");
  const controller = useMemo<WorkspaceController>(
    () => ({
      canUndo: layoutHistory.current.length > 0,
      catalog,
      currentWorkspace,
      panels: panels.map((panel) => ({
        id: panel.id,
        label: panel.label,
        visible: visiblePanelIds.has(panel.id),
      })),
      deleteCurrentWorkspace,
      renameCurrentWorkspace,
      resetToSavedLayout,
      saveAs: saveAsNamedWorkspace,
      select: selectNamedWorkspace,
      setPanelVisible: (panelId, visible) =>
        commit((current) =>
          visible ? reopenPanel(current, panelId) : closePanel(current, panelId),
        ),
      undoLayoutChange,
    }),
    [
      catalog,
      commit,
      currentWorkspace,
      deleteCurrentWorkspace,
      panels,
      renameCurrentWorkspace,
      resetToSavedLayout,
      saveAsNamedWorkspace,
      selectNamedWorkspace,
      undoLayoutChange,
      visiblePanelIds,
    ],
  );
  useEffect(() => registerWorkspaceController(controller), [controller]);
  const api = useMemo<WorkspaceApi>(
    () => ({
      canUndo: layoutHistory.current.length > 0,
      closedPanelIds: layout.closedPanels,
      close,
      reopen,
      undoLayoutChange,
    }),
    [close, layout, reopen, undoLayoutChange],
  );
  const groups = workspaceTabGroups(layout);
  const common = {
    canUndo: layoutHistory.current.length > 0,
    panels: panelMap,
    groups,
    drag,
    maximizedGroupId,
    onActivate: (groupId: string, panelId: string) =>
      commit((current) => activatePanel(current, groupId, panelId)),
    onClose: close,
    onCloseGroup: (groupId: string) => {
      commit((current) => closeGroup(current, groupId));
      setMaximizedGroupId(null);
    },
    onCloseOthers: (groupId: string, panelId: string) =>
      commit((current) => closeOtherPanels(current, groupId, panelId)),
    onDockGroup: (groupId: string) => commit((current) => dockGroupToRoot(current, groupId)),
    onDockPanel: (panelId: string) => commit((current) => dockPanelToRoot(current, panelId)),
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
    onFloatPanel: (panelId: string, bounds: DOMRect) =>
      commit((current) =>
        floatPanel(current, panelId, {
          x: Math.max(8, bounds.x),
          y: Math.max(40, bounds.y),
          width: Math.max(300, bounds.width),
          height: Math.max(180, bounds.height),
        }),
      ),
    onHover: setHoveredGroupId,
    onMaximize: toggleMaximize,
    onMoveGroup: (sourceGroupId: string, targetGroupId: string, position: WorkspaceDockPosition) =>
      commit((current) => dockGroup(current, sourceGroupId, targetGroupId, position)),
    onMovePanel: (panelId: string, targetGroupId: string, position: WorkspaceDockPosition) =>
      commit((current) => dockPanel(current, panelId, targetGroupId, position)),
    onTabDrop: (panelId: string, targetGroupId: string, slot: number) =>
      commit((current) => movePanelToTabSlot(current, panelId, targetGroupId, slot)),
    onResize: (splitId: string, ratio: number) =>
      commit((current) => resizeSplit(current, splitId, ratio)),
    onUndo: undoLayoutChange,
  } as const;
  const maximizedNode = maximizedGroupId ? findWorkspaceNode(layout, maximizedGroupId) : undefined;
  const renderedRoot = maximizedNode ?? layout.root;
  return (
    <WorkspaceApiContext.Provider value={api}>
      <div
        className="editor-grid workspace-root"
        data-maximized={maximizedNode ? "true" : undefined}
        ref={rootRef}
      >
        {renderedRoot ? <DockNode {...common} node={renderedRoot} /> : <EmptyWorkspace />}
        {!maximizedNode
          ? layout.floating.map((entry) => (
              <FloatingWorkspaceFrame
                {...common}
                active={activeFloatingId === entry.id}
                entry={entry}
                key={entry.id}
                onFocus={() => setActiveFloatingId(entry.id)}
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
