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
import { isDesktopRuntime, onDisplayMetricsChanged } from "../../desktop/api";
import { isEditableShortcutTarget, isEditorShortcutBlocked } from "../../ui/keyboard-shortcuts";
import { DEFAULT_WORKSPACE_LAYOUT } from "../../workspace/default-layout";
import {
  remapFloatingWorkspacesToHost,
  type WorkspaceFloatingHost,
} from "../../workspace/floating-host";
import { applyWorkspaceDrop, type WorkspaceDrag } from "../../workspace/interaction";
import {
  activatePanel,
  closeGroup,
  closeOtherPanels,
  closePanel,
  createViewer,
  dockGroup,
  dockGroupToRoot,
  dockPanel,
  dockPanelToRoot,
  findWorkspaceNode,
  floatGroup,
  floatPanel,
  MAX_VIEWER_INSTANCES_PER_SOURCE,
  movePanelToTabSlot,
  normalizeWorkspaceLayout,
  reopenPanel,
  resizeSplit,
  setFloatingBounds,
  setGroupPresentation,
  setViewerLock,
  toggleMaximizedGroup,
  toggleStackPanel,
  toggleStackSolo,
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
import type { WorkspaceViewerIdentity } from "./WorkspaceViewerIdentity";
import { WorkspaceViewerIdentityProvider } from "./WorkspaceViewerIdentity";
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
  viewerContextId,
}: {
  readonly panels: readonly WorkspacePanelDefinition[];
  readonly initialLayout?: WorkspaceLayout;
  readonly viewerContextId?: string;
}) {
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
  const [activeFloatingId, setActiveFloatingId] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const layoutHistory = useRef<WorkspaceLayout[]>([]);
  const layoutRef = useRef(layout);
  const hoveredGroupRef = useRef<string | null>(null);
  const hostDisplayId = useRef<string | undefined>(undefined);
  layoutRef.current = layout;
  hoveredGroupRef.current = hoveredGroupId;
  const viewerIdentities = useMemo(
    () => workspaceViewerIdentities(panels, layout, viewerContextId),
    [layout, panels, viewerContextId],
  );
  const panelMap = useMemo(
    () => workspacePanelDefinitions(panels, viewerIdentities),
    [panels, viewerIdentities],
  );

  const commit = useCallback((update: (current: WorkspaceLayout) => WorkspaceLayout) => {
    setLayout((current) => {
      const next = normalizeWorkspaceLayout(update(current));
      if (next !== current) {
        layoutHistory.current = [...layoutHistory.current.slice(-29), current];
        saveWorkspaceLayout(next);
      }
      return next;
    });
  }, []);
  const reconcileFloatingHost = useCallback(() => {
    const root = rootRef.current;
    if (!root) return;
    setLayout((current) => {
      const next = remapFloatingWorkspacesToHost(
        current,
        workspaceFloatingHost(root, hostDisplayId.current),
      );
      if (next !== current) saveWorkspaceLayout(next);
      return next;
    });
  }, []);
  useEffect(() => {
    reconcileFloatingHost();
    let pendingFrame: number | undefined;
    const reconcileAfterLayout = () => {
      reconcileFloatingHost();
      if (pendingFrame !== undefined) window.cancelAnimationFrame(pendingFrame);
      pendingFrame = window.requestAnimationFrame(() => {
        pendingFrame = undefined;
        reconcileFloatingHost();
      });
    };
    const resizeObserver =
      typeof ResizeObserver === "undefined"
        ? undefined
        : new ResizeObserver(() => reconcileFloatingHost());
    if (rootRef.current) resizeObserver?.observe(rootRef.current);
    window.addEventListener("resize", reconcileAfterLayout);
    const unsubscribe = isDesktopRuntime()
      ? onDisplayMetricsChanged((metrics) => {
          hostDisplayId.current = metrics.currentDisplayId;
          reconcileAfterLayout();
        })
      : undefined;
    return () => {
      if (pendingFrame !== undefined) window.cancelAnimationFrame(pendingFrame);
      resizeObserver?.disconnect();
      window.removeEventListener("resize", reconcileAfterLayout);
      unsubscribe?.();
    };
  }, [reconcileFloatingHost]);
  const undoLayoutChange = useCallback(() => {
    const previous = layoutHistory.current[layoutHistory.current.length - 1];
    if (!previous) return;
    layoutHistory.current = layoutHistory.current.slice(0, -1);
    setLayout(previous);
    saveWorkspaceLayout(previous);
  }, []);
  const toggleMaximize = useCallback(
    (groupId: string) => commit((current) => toggleMaximizedGroup(current, groupId)),
    [commit],
  );
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (isEditorShortcutBlocked(event) || isEditableShortcutTarget(event.target)) return;
      if ((event.ctrlKey || event.metaKey) && event.altKey && event.key.toLowerCase() === "z") {
        event.preventDefault();
        undoLayoutChange();
        return;
      }
      if (
        (event.ctrlKey || event.metaKey) &&
        event.altKey &&
        event.shiftKey &&
        event.key.toLowerCase() === "n"
      ) {
        const focusedGroupId = (document.activeElement as HTMLElement | null)?.closest<HTMLElement>(
          "[data-workspace-group]",
        )?.dataset.workspaceGroup;
        const groupId = focusedGroupId ?? hoveredGroupRef.current;
        const group = workspaceTabGroups(layoutRef.current).find(
          (candidate) => candidate.group.id === groupId,
        )?.group;
        const definition = group ? panelMap.get(group.activePanelId) : undefined;
        if (!group || !definition?.viewerType) return;
        event.preventDefault();
        commit((current) =>
          createViewer(
            current,
            group.activePanelId,
            sourcePanelId(current, group.activePanelId),
            definition.viewerType ?? "viewer",
            viewerContextId,
            true,
          ),
        );
        return;
      }
      if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === "w") {
        const focusedGroupId = (document.activeElement as HTMLElement | null)?.closest<HTMLElement>(
          "[data-workspace-group]",
        )?.dataset.workspaceGroup;
        const groupId = focusedGroupId ?? hoveredGroupRef.current;
        const group = workspaceTabGroups(layoutRef.current).find(
          (candidate) => candidate.group.id === groupId,
        )?.group;
        if (!group) return;
        event.preventDefault();
        if (event.shiftKey) commit((current) => closeGroup(current, group.id));
        else commit((current) => closePanel(current, group.activePanelId));
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
  }, [commit, panelMap, toggleMaximize, undoLayoutChange, viewerContextId]);

  const close = useCallback(
    (panelId: string) => commit((current) => closePanel(current, panelId)),
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
  const deleteNamedWorkspace = useCallback(
    (workspaceId: string) => {
      const next = deleteWorkspace(catalog, workspaceId);
      if (next === catalog) return;
      setCatalog(next);
      saveWorkspaceCatalog(next);
    },
    [catalog],
  );
  const resetToSavedLayout = useCallback(() => {
    const workspace = workspaceById(catalog, catalog.currentWorkspaceId);
    if (workspace) commit(() => workspace.layout);
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
      deleteWorkspace: deleteNamedWorkspace,
      renameCurrentWorkspace,
      resetToSavedLayout,
      saveAs: saveAsNamedWorkspace,
      select: selectNamedWorkspace,
      setPanelVisible: (panelId, visible) =>
        commit((current) => {
          if (!visible) return closePanel(current, panelId);
          const revealed = reopenPanel(current, panelId);
          const location = workspaceTabGroups(revealed).find(({ group }) =>
            group.panels.includes(panelId),
          );
          return location ? activatePanel(revealed, location.group.id, panelId) : revealed;
        }),
      undoLayoutChange,
    }),
    [
      catalog,
      commit,
      currentWorkspace,
      deleteNamedWorkspace,
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
    maximizedGroupId: layout.maximizedGroupId ?? null,
    onActivate: (groupId: string, panelId: string) =>
      commit((current) => activatePanel(current, groupId, panelId)),
    onClose: close,
    onCloseGroup: (groupId: string) => {
      commit((current) => closeGroup(current, groupId));
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
    onSetPresentation: (groupId: string, presentation: "tabs" | "stacked") =>
      commit((current) => setGroupPresentation(current, groupId, presentation)),
    onToggleStackPanel: (
      groupId: string,
      panelId: string,
      simultaneous: boolean,
      toggleSolo: boolean,
    ) => commit((current) => toggleStackPanel(current, groupId, panelId, simultaneous, toggleSolo)),
    onToggleStackSolo: (groupId: string) => commit((current) => toggleStackSolo(current, groupId)),
    onToggleViewerLock: (panelId: string, sourceId: string, viewerType: string, locked: boolean) =>
      commit((current) =>
        setViewerLock(current, panelId, sourceId, viewerType, locked, viewerContextId),
      ),
    onCreateViewer: (panelId: string, sourceId: string, viewerType: string, split: boolean) =>
      commit((current) =>
        createViewer(current, panelId, sourceId, viewerType, viewerContextId, split),
      ),
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
  const maximizedNode = layout.maximizedGroupId
    ? findWorkspaceNode(layout, layout.maximizedGroupId)
    : undefined;
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
                  commit((current) => {
                    const moved = setFloatingBounds(current, floatingId, bounds);
                    const root = rootRef.current;
                    return root
                      ? remapFloatingWorkspacesToHost(
                          moved,
                          workspaceFloatingHost(root, hostDisplayId.current),
                        )
                      : moved;
                  })
                }
              />
            ))
          : null}
      </div>
    </WorkspaceApiContext.Provider>
  );
}

function workspaceFloatingHost(
  root: HTMLElement,
  displayId: string | undefined,
): WorkspaceFloatingHost {
  const bounds = root.getBoundingClientRect();
  const width = bounds.width > 0 ? bounds.right : root.clientWidth || window.innerWidth;
  const height = bounds.height > 0 ? bounds.bottom : root.clientHeight || window.innerHeight;
  return {
    width,
    height,
    displayId,
    ...(bounds.width > 0 ? { leftInset: bounds.left } : {}),
    ...(bounds.height > 0 ? { topInset: bounds.top } : {}),
  };
}

function workspacePanelDefinitions(
  panels: readonly WorkspacePanelDefinition[],
  identities: ReadonlyMap<string, WorkspaceViewerIdentity>,
): ReadonlyMap<string, WorkspacePanelDefinition> {
  const sources = new Map(panels.map((panel) => [panel.id, panel]));
  const definitions = new Map(sources);
  for (const [panelId, identity] of identities) {
    const source = sources.get(identity.sourcePanelId);
    if (!source) continue;
    definitions.set(panelId, {
      ...source,
      id: panelId,
      label: panelId === source.id ? source.label : `${source.label} ${viewerOrdinal(panelId)}`,
      element: (
        <WorkspaceViewerIdentityProvider identity={identity}>
          {source.element}
        </WorkspaceViewerIdentityProvider>
      ),
      viewerIdentity: identity,
      viewerCanCreate:
        [...identities.values()].filter(
          (candidate) => candidate.sourcePanelId === identity.sourcePanelId,
        ).length < MAX_VIEWER_INSTANCES_PER_SOURCE,
    });
  }
  return definitions;
}

function workspaceViewerIdentities(
  panels: readonly WorkspacePanelDefinition[],
  layout: WorkspaceLayout,
  viewerContextId?: string,
): ReadonlyMap<string, WorkspaceViewerIdentity> {
  const definitions = new Map(panels.map((panel) => [panel.id, panel]));
  const viewers = new Map((layout.viewers ?? []).map((viewer) => [viewer.id, viewer]));
  const identities = new Map<string, WorkspaceViewerIdentity>();
  for (const panelId of workspacePanelIds(layout)) {
    const viewer = viewers.get(panelId);
    const source = definitions.get(viewer?.sourcePanelId ?? panelId);
    if (!source?.viewerType) continue;
    identities.set(panelId, {
      id: panelId,
      sourcePanelId: source.id,
      viewerType: source.viewerType,
      locked: viewer?.locked ?? false,
      contextId: viewer?.locked ? viewer.contextId : viewerContextId,
    });
  }
  return identities;
}

function sourcePanelId(layout: WorkspaceLayout, panelId: string): string {
  return layout.viewers?.find((viewer) => viewer.id === panelId)?.sourcePanelId ?? panelId;
}

function viewerOrdinal(panelId: string): string {
  return /::viewer-(\d+)$/.exec(panelId)?.[1] ?? "2";
}

function EmptyWorkspace(): ReactNode {
  return <div className="workspace-empty" />;
}
