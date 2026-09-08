import {
  clampSplitRatio,
  compareIds,
  normalizeBounds,
  normalizedExpandedPanels,
  normalizeOptionalId,
  sameBounds,
  sameViewer,
  validId,
} from "./layout-normalization";

import {
  detachVisiblePanel,
  detachWorkspaceNode,
  findWorkspaceNode,
  firstTabGroupId,
  nextLayoutId,
  nextViewerId,
  nodeHasPanel,
  nodePanelIds,
  removeClosedPanel,
  replaceNodeInLayout,
  viewerInstanceCount,
  withoutMaximizedGroup,
  workspacePanelIds,
  workspaceTabGroups,
} from "./layout-tree";
import {
  type FloatingWorkspace,
  MAX_VIEWER_INSTANCES_PER_SOURCE,
  type WorkspaceAxis,
  type WorkspaceBounds,
  type WorkspaceDockPosition,
  type WorkspaceGroupPresentation,
  type WorkspaceLayout,
  type WorkspaceTabGroup,
  type WorkspaceViewerInstance,
} from "./layout-types";

export function setGroupPresentation(
  layout: WorkspaceLayout,
  groupId: string,
  presentation: WorkspaceGroupPresentation,
): WorkspaceLayout {
  return (
    replaceNodeInLayout(layout, groupId, (node) => {
      if (node.kind !== "tabGroup") return node;
      const current = node.presentation ?? "tabs";
      if (current === presentation) return node;
      if (presentation === "tabs") {
        const {
          expandedPanelIds: _expanded,
          presentation: _presentation,
          stackSolo: _solo,
          ...group
        } = node;
        return group;
      }
      return {
        ...node,
        presentation,
        stackSolo: true,
        expandedPanelIds: [node.activePanelId],
      };
    }) ?? layout
  );
}

export function toggleStackSolo(layout: WorkspaceLayout, groupId: string): WorkspaceLayout {
  return (
    replaceNodeInLayout(layout, groupId, (node) => {
      if (node.kind !== "tabGroup" || node.presentation !== "stacked") return node;
      const stackSolo = !(node.stackSolo ?? true);
      const expandedPanelIds = stackSolo
        ? [node.activePanelId]
        : normalizedExpandedPanels(node, node.expandedPanelIds);
      return { ...node, stackSolo, expandedPanelIds };
    }) ?? layout
  );
}

export function toggleStackPanel(
  layout: WorkspaceLayout,
  groupId: string,
  panelId: string,
  simultaneous = false,
  toggleSoloMode = false,
): WorkspaceLayout {
  return (
    replaceNodeInLayout(layout, groupId, (node) => {
      if (
        node.kind !== "tabGroup" ||
        node.presentation !== "stacked" ||
        !node.panels.includes(panelId)
      )
        return node;
      const expanded = normalizedExpandedPanels(node, node.expandedPanelIds);
      const currentlyExpanded = expanded.includes(panelId);
      const stackSolo = toggleSoloMode ? !(node.stackSolo ?? true) : (node.stackSolo ?? true);
      let expandedPanelIds: readonly string[];
      if (simultaneous) {
        const expandAll = !currentlyExpanded;
        expandedPanelIds = expandAll ? [...node.panels] : [];
      } else if (stackSolo) {
        expandedPanelIds = currentlyExpanded && expanded.length === 1 ? [] : [panelId];
      } else {
        expandedPanelIds = currentlyExpanded
          ? expanded.filter((candidate) => candidate !== panelId)
          : node.panels.filter(
              (candidate) => candidate === panelId || expanded.includes(candidate),
            );
      }
      return {
        ...node,
        activePanelId: panelId,
        expandedPanelIds,
        stackSolo,
      };
    }) ?? layout
  );
}

export function toggleMaximizedGroup(layout: WorkspaceLayout, groupId: string): WorkspaceLayout {
  const group = findWorkspaceNode(layout, groupId);
  if (group?.kind !== "tabGroup") return layout;
  return layout.maximizedGroupId === groupId
    ? withoutMaximizedGroup(layout)
    : { ...layout, maximizedGroupId: groupId };
}

export function setViewerLock(
  layout: WorkspaceLayout,
  panelId: string,
  sourcePanelId: string,
  viewerType: string,
  locked: boolean,
  contextId?: string,
): WorkspaceLayout {
  if (
    !workspacePanelIds(layout).includes(panelId) ||
    !validId(sourcePanelId) ||
    !validId(viewerType)
  )
    return layout;
  const viewers = [...(layout.viewers ?? [])];
  const index = viewers.findIndex((viewer) => viewer.id === panelId);
  const current = index >= 0 ? viewers[index] : undefined;
  const next: WorkspaceViewerInstance = {
    id: panelId,
    sourcePanelId: current?.sourcePanelId ?? sourcePanelId,
    viewerType: current?.viewerType ?? viewerType,
    locked,
    ...(locked && validId(contextId ?? "") ? { contextId: contextId?.trim() } : {}),
  };
  if (current && sameViewer(current, next)) return layout;
  if (index >= 0) viewers[index] = next;
  else viewers.push(next);
  return { ...layout, viewers };
}

export function createViewer(
  layout: WorkspaceLayout,
  panelId: string,
  sourcePanelId: string,
  viewerType: string,
  contextId?: string,
  split = false,
): WorkspaceLayout {
  const location = workspaceTabGroups(layout).find(({ group }) => group.panels.includes(panelId));
  if (!location || !validId(sourcePanelId) || !validId(viewerType)) return layout;
  if (viewerInstanceCount(layout, sourcePanelId) >= MAX_VIEWER_INSTANCES_PER_SOURCE) return layout;
  const viewerId = nextViewerId(layout, sourcePanelId);
  const current = setViewerLock(layout, panelId, sourcePanelId, viewerType, split, contextId);
  const viewers: readonly WorkspaceViewerInstance[] = [
    ...(current.viewers ?? []),
    { id: viewerId, sourcePanelId, viewerType, locked: false },
  ];
  const withViewer = { ...current, viewers };
  return split
    ? dockPanel(withViewer, viewerId, location.group.id, "right")
    : dockPanel(withViewer, viewerId, location.group.id, "center");
}

export function dockPanel(
  layout: WorkspaceLayout,
  panelId: string,
  targetNodeId: string,
  position: WorkspaceDockPosition,
): WorkspaceLayout {
  if (!validId(panelId) || !validId(targetNodeId)) return layout;
  const target = findWorkspaceNode(layout, targetNodeId);
  if (!target || (position === "center" && target.kind !== "tabGroup")) return layout;

  if (position === "center" && target.kind === "tabGroup" && target.panels.includes(panelId)) {
    if (target.activePanelId === panelId) return layout;
    return (
      replaceNodeInLayout(layout, targetNodeId, (node) =>
        node.kind === "tabGroup" ? { ...node, activePanelId: panelId } : node,
      ) ?? layout
    );
  }
  if (position !== "center" && nodePanelIds(target).length === 1 && nodeHasPanel(target, panelId))
    return layout;

  const detached = detachVisiblePanel(layout, panelId);
  const base = removeClosedPanel(detached.layout, panelId);
  if (!findWorkspaceNode(base, targetNodeId)) return layout;

  if (position === "center") {
    return (
      replaceNodeInLayout(base, targetNodeId, (node) =>
        node.kind === "tabGroup"
          ? { ...node, panels: [...node.panels, panelId], activePanelId: panelId }
          : node,
      ) ?? layout
    );
  }

  const panelGroup: WorkspaceTabGroup = {
    kind: "tabGroup",
    id: nextLayoutId(base, "tab-group"),
    panels: [panelId],
    activePanelId: panelId,
  };
  const axis: WorkspaceAxis =
    position === "left" || position === "right" ? "horizontal" : "vertical";
  const insertFirst = position === "left" || position === "top";
  return (
    replaceNodeInLayout(base, targetNodeId, (node) => ({
      kind: "split",
      id: nextLayoutId(base, "split"),
      axis,
      ratio: 0.5,
      first: insertFirst ? panelGroup : node,
      second: insertFirst ? node : panelGroup,
    })) ?? layout
  );
}

export function groupPanel(
  layout: WorkspaceLayout,
  panelId: string,
  targetGroupId: string,
): WorkspaceLayout {
  return dockPanel(layout, panelId, targetGroupId, "center");
}

/**
 * Moves a panel to an exact insertion slot in a tab strip. Slots are measured against the
 * target strip before the panel is detached, so native drag events can use the hovered tab edge
 * without compensating for same-group moves. Empty source groups collapse atomically.
 */
export function movePanelToTabSlot(
  layout: WorkspaceLayout,
  panelId: string,
  targetGroupId: string,
  slot: number,
): WorkspaceLayout {
  if (!validId(panelId) || !validId(targetGroupId) || !Number.isFinite(slot)) return layout;
  const target = findWorkspaceNode(layout, targetGroupId);
  if (target?.kind !== "tabGroup") return layout;
  const source = workspaceTabGroups(layout).find(({ group }) => group.panels.includes(panelId));
  if (!source) return layout;

  const requestedSlot = Math.max(0, Math.min(target.panels.length, Math.trunc(slot)));
  const sourceIndex = source.group.id === targetGroupId ? source.group.panels.indexOf(panelId) : -1;
  const detached = detachVisiblePanel(layout, panelId);
  if (!detached.removed) return layout;
  const nextTarget = findWorkspaceNode(detached.layout, targetGroupId);
  if (nextTarget?.kind !== "tabGroup") return layout;
  const adjustedSlot =
    sourceIndex >= 0 && requestedSlot > sourceIndex ? requestedSlot - 1 : requestedSlot;
  const insertionIndex = Math.max(0, Math.min(nextTarget.panels.length, adjustedSlot));
  const panels = [...nextTarget.panels];
  panels.splice(insertionIndex, 0, panelId);
  const unchanged =
    source.group.id === targetGroupId &&
    panels.length === source.group.panels.length &&
    panels.every((candidate, index) => candidate === source.group.panels[index]);
  if (unchanged) return activatePanel(layout, targetGroupId, panelId);

  const base = removeClosedPanel(detached.layout, panelId);
  return (
    replaceNodeInLayout(base, targetGroupId, (node) =>
      node.kind === "tabGroup" ? { ...node, panels, activePanelId: panelId } : node,
    ) ?? layout
  );
}

export function activatePanel(
  layout: WorkspaceLayout,
  groupId: string,
  panelId: string,
): WorkspaceLayout {
  if (!validId(groupId) || !validId(panelId)) return layout;
  return (
    replaceNodeInLayout(layout, groupId, (node) =>
      node.kind === "tabGroup" && node.panels.includes(panelId) && node.activePanelId !== panelId
        ? { ...node, activePanelId: panelId }
        : node,
    ) ?? layout
  );
}

/** Moves a complete tab group without cloning unaffected layout branches. */
export function dockGroup(
  layout: WorkspaceLayout,
  sourceGroupId: string,
  targetGroupId: string,
  position: WorkspaceDockPosition,
): WorkspaceLayout {
  if (!validId(sourceGroupId) || !validId(targetGroupId) || sourceGroupId === targetGroupId)
    return layout;
  const source = findWorkspaceNode(layout, sourceGroupId);
  const target = findWorkspaceNode(layout, targetGroupId);
  if (source?.kind !== "tabGroup" || target?.kind !== "tabGroup") return layout;

  const detached = detachWorkspaceNode(layout, sourceGroupId);
  if (!detached.node || !findWorkspaceNode(detached.layout, targetGroupId)) return layout;
  const base = detached.layout;
  if (position === "center") {
    return (
      replaceNodeInLayout(base, targetGroupId, (node) =>
        node.kind === "tabGroup"
          ? {
              ...node,
              panels: [...node.panels, ...source.panels],
              activePanelId: source.activePanelId,
            }
          : node,
      ) ?? layout
    );
  }

  const axis: WorkspaceAxis =
    position === "left" || position === "right" ? "horizontal" : "vertical";
  const insertFirst = position === "left" || position === "top";
  return (
    replaceNodeInLayout(base, targetGroupId, (node) => ({
      kind: "split",
      id: nextLayoutId(base, "split"),
      axis,
      ratio: 0.5,
      first: insertFirst ? source : node,
      second: insertFirst ? node : source,
    })) ?? layout
  );
}

export function floatPanel(
  layout: WorkspaceLayout,
  panelId: string,
  bounds: WorkspaceBounds,
  displayId?: string,
): WorkspaceLayout {
  if (!validId(panelId)) return layout;
  const normalizedBounds = normalizeBounds(bounds);
  const normalizedDisplayId = normalizeOptionalId(displayId);
  const existingIndex = layout.floating.findIndex(
    (entry) =>
      entry.node.kind === "tabGroup" &&
      entry.node.panels.length === 1 &&
      entry.node.panels[0] === panelId,
  );
  if (existingIndex >= 0) {
    const existing = layout.floating[existingIndex];
    if (sameBounds(existing.bounds, normalizedBounds) && existing.displayId === normalizedDisplayId)
      return layout;
    const floating = [...layout.floating];
    floating[existingIndex] = {
      ...existing,
      bounds: normalizedBounds,
      ...(normalizedDisplayId ? { displayId: normalizedDisplayId } : { displayId: undefined }),
    };
    return { ...layout, floating };
  }

  const detached = detachVisiblePanel(layout, panelId);
  const base = removeClosedPanel(detached.layout, panelId);
  const entry: FloatingWorkspace = {
    id: nextLayoutId(base, "floating"),
    node: {
      kind: "tabGroup",
      id: nextLayoutId(base, "tab-group"),
      panels: [panelId],
      activePanelId: panelId,
    },
    bounds: normalizedBounds,
    ...(normalizedDisplayId ? { displayId: normalizedDisplayId } : {}),
  };
  return { ...base, floating: [...base.floating, entry] };
}

export function floatGroup(
  layout: WorkspaceLayout,
  groupId: string,
  bounds: WorkspaceBounds,
  displayId?: string,
): WorkspaceLayout {
  const source = findWorkspaceNode(layout, groupId);
  if (source?.kind !== "tabGroup") return layout;
  const existing = layout.floating.find((entry) => entry.node.id === groupId);
  if (existing) return setFloatingBounds(layout, existing.id, bounds, displayId);
  const detached = detachWorkspaceNode(layout, groupId);
  if (!detached.node) return layout;
  const normalizedDisplayId = normalizeOptionalId(displayId);
  return {
    ...detached.layout,
    floating: [
      ...detached.layout.floating,
      {
        id: nextLayoutId(detached.layout, "floating"),
        node: detached.node,
        bounds: normalizeBounds(bounds),
        ...(normalizedDisplayId ? { displayId: normalizedDisplayId } : {}),
      },
    ],
  };
}

export function setFloatingBounds(
  layout: WorkspaceLayout,
  floatingId: string,
  bounds: WorkspaceBounds,
  displayId?: string,
): WorkspaceLayout {
  const index = layout.floating.findIndex((entry) => entry.id === floatingId);
  if (index < 0) return layout;
  const entry = layout.floating[index];
  const nextBounds = normalizeBounds(bounds);
  const nextDisplayId = normalizeOptionalId(displayId ?? entry.displayId);
  if (sameBounds(entry.bounds, nextBounds) && entry.displayId === nextDisplayId) return layout;
  const floating = [...layout.floating];
  floating[index] = {
    ...entry,
    bounds: nextBounds,
    ...(nextDisplayId ? { displayId: nextDisplayId } : { displayId: undefined }),
  };
  return { ...layout, floating };
}

export function closePanel(layout: WorkspaceLayout, panelId: string): WorkspaceLayout {
  if (!validId(panelId) || layout.closedPanels.includes(panelId)) return layout;
  const detached = detachVisiblePanel(layout, panelId);
  if (!detached.removed) return layout;
  const viewer = layout.viewers?.find((candidate) => candidate.id === panelId);
  if (viewer && viewer.id !== viewer.sourcePanelId) {
    const viewers = (detached.layout.viewers ?? []).filter((candidate) => candidate.id !== panelId);
    if (viewers.length > 0) return { ...detached.layout, viewers };
    const { viewers: _removed, ...withoutViewers } = detached.layout;
    return withoutViewers;
  }
  return {
    ...detached.layout,
    closedPanels: [...detached.layout.closedPanels, panelId].sort(compareIds),
  };
}

export function closeOtherPanels(
  layout: WorkspaceLayout,
  groupId: string,
  panelId: string,
): WorkspaceLayout {
  const group = findWorkspaceNode(layout, groupId);
  if (group?.kind !== "tabGroup" || !group.panels.includes(panelId)) return layout;
  return group.panels.reduce(
    (current, candidate) => (candidate === panelId ? current : closePanel(current, candidate)),
    layout,
  );
}

export function closeGroup(layout: WorkspaceLayout, groupId: string): WorkspaceLayout {
  const group = findWorkspaceNode(layout, groupId);
  if (group?.kind !== "tabGroup") return layout;
  return group.panels.reduce((current, panelId) => closePanel(current, panelId), layout);
}

export function reopenPanel(
  layout: WorkspaceLayout,
  panelId: string,
  targetNodeId?: string,
  position: WorkspaceDockPosition = "center",
): WorkspaceLayout {
  if (!layout.closedPanels.includes(panelId)) return layout;
  if (!layout.root) {
    const base = removeClosedPanel(layout, panelId);
    return {
      ...base,
      root: {
        kind: "tabGroup",
        id: nextLayoutId(base, "tab-group"),
        panels: [panelId],
        activePanelId: panelId,
      },
    };
  }
  const destination = targetNodeId ?? firstTabGroupId(layout.root);
  if (!destination || !findWorkspaceNode(layout, destination)) return layout;
  return dockPanel(layout, panelId, destination, position);
}

export function dockPanelToRoot(layout: WorkspaceLayout, panelId: string): WorkspaceLayout {
  const location = workspaceTabGroups(layout).find(({ group }) => group.panels.includes(panelId));
  if (!location?.floatingId) return layout;
  if (layout.root) return dockPanel(layout, panelId, firstTabGroupId(layout.root), "center");
  const detached = detachVisiblePanel(layout, panelId);
  if (!detached.removed) return layout;
  return {
    ...detached.layout,
    root: {
      kind: "tabGroup",
      id: nextLayoutId(detached.layout, "tab-group"),
      panels: [panelId],
      activePanelId: panelId,
    },
  };
}

export function dockGroupToRoot(layout: WorkspaceLayout, groupId: string): WorkspaceLayout {
  const location = workspaceTabGroups(layout).find(({ group }) => group.id === groupId);
  if (!location?.floatingId) return layout;
  if (layout.root) return dockGroup(layout, groupId, firstTabGroupId(layout.root), "center");
  const detached = detachWorkspaceNode(layout, groupId);
  return detached.node ? { ...detached.layout, root: detached.node } : layout;
}

export function resizeSplit(
  layout: WorkspaceLayout,
  splitId: string,
  ratio: number,
): WorkspaceLayout {
  if (!validId(splitId)) return layout;
  const nextRatio = clampSplitRatio(ratio);
  return (
    replaceNodeInLayout(layout, splitId, (node) =>
      node.kind === "split" && node.ratio !== nextRatio ? { ...node, ratio: nextRatio } : node,
    ) ?? layout
  );
}

export { normalizeWorkspaceLayout } from "./layout-normalization";
export { findWorkspaceNode, workspacePanelIds, workspaceTabGroups } from "./layout-tree";
export type {
  FloatingWorkspace,
  WorkspaceAxis,
  WorkspaceBounds,
  WorkspaceDockPosition,
  WorkspaceGroupLocation,
  WorkspaceGroupPresentation,
  WorkspaceLayout,
  WorkspaceNode,
  WorkspaceSplit,
  WorkspaceTabGroup,
  WorkspaceViewerInstance,
} from "./layout-types";
export { MAX_SPLIT_RATIO, MAX_VIEWER_INSTANCES_PER_SOURCE, MIN_SPLIT_RATIO } from "./layout-types";
