export type WorkspaceAxis = "horizontal" | "vertical";
export type WorkspaceDockPosition = "center" | "left" | "right" | "top" | "bottom";

export interface WorkspaceTabGroup {
  readonly kind: "tabGroup";
  readonly id: string;
  readonly panels: readonly string[];
  readonly activePanelId: string;
}

export interface WorkspaceSplit {
  readonly kind: "split";
  readonly id: string;
  readonly axis: WorkspaceAxis;
  readonly ratio: number;
  readonly first: WorkspaceNode;
  readonly second: WorkspaceNode;
}

export type WorkspaceNode = WorkspaceTabGroup | WorkspaceSplit;

export interface WorkspaceBounds {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface FloatingWorkspace {
  readonly id: string;
  readonly node: WorkspaceNode;
  readonly bounds: WorkspaceBounds;
  readonly displayId?: string;
}

export interface WorkspaceLayout {
  readonly root: WorkspaceNode | null;
  readonly floating: readonly FloatingWorkspace[];
  readonly closedPanels: readonly string[];
}

export interface WorkspaceGroupLocation {
  readonly group: WorkspaceTabGroup;
  readonly floatingId?: string;
}

export const MIN_SPLIT_RATIO = 0.1;
export const MAX_SPLIT_RATIO = 0.9;

const MIN_FLOATING_WIDTH = 160;
const MIN_FLOATING_HEIGHT = 120;
const MAX_FLOATING_DIMENSION = 100_000;
const MAX_FLOATING_COORDINATE = 1_000_000;

interface NormalizeContext {
  readonly panelIds: Set<string>;
}

interface NodeResult {
  readonly node: WorkspaceNode | null;
  readonly removed: boolean;
}

interface ReplaceResult {
  readonly node: WorkspaceNode;
  readonly found: boolean;
}

/**
 * Restores the layout invariants without rebuilding branches that are already canonical.
 * Visible panels win over later duplicates, followed by closed panels in lexical order.
 */
export function normalizeWorkspaceLayout(layout: WorkspaceLayout): WorkspaceLayout {
  const context: NormalizeContext = { panelIds: new Set() };
  const root = layout.root ? normalizeNode(layout.root, context) : null;
  let floatingChanged = false;
  const floatingIds = new Set<string>();
  const floating: FloatingWorkspace[] = [];
  for (const entry of layout.floating) {
    if (!validId(entry.id) || floatingIds.has(entry.id)) {
      floatingChanged = true;
      continue;
    }
    floatingIds.add(entry.id);
    const node = normalizeNode(entry.node, context);
    if (!node) {
      floatingChanged = true;
      continue;
    }
    const bounds = normalizeBounds(entry.bounds);
    const displayId = normalizeOptionalId(entry.displayId);
    const unchanged =
      node === entry.node && sameBounds(bounds, entry.bounds) && displayId === entry.displayId;
    floating.push(
      unchanged
        ? entry
        : {
            id: entry.id,
            node,
            bounds,
            ...(displayId ? { displayId } : {}),
          },
    );
    if (!unchanged) floatingChanged = true;
  }
  if (floating.length !== layout.floating.length) floatingChanged = true;

  const closedPanels = [...new Set(layout.closedPanels.filter(validId))]
    .filter((panelId) => !context.panelIds.has(panelId))
    .sort(compareIds);
  const closedChanged = !sameStringArray(closedPanels, layout.closedPanels);
  const rootChanged = root !== layout.root;
  if (!rootChanged && !floatingChanged && !closedChanged) return layout;
  return {
    root,
    floating: floatingChanged ? floating : layout.floating,
    closedPanels: closedChanged ? closedPanels : layout.closedPanels,
  };
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

export function findWorkspaceNode(
  layout: WorkspaceLayout,
  nodeId: string,
): WorkspaceNode | undefined {
  const root = layout.root ? findNode(layout.root, nodeId) : undefined;
  if (root) return root;
  for (const entry of layout.floating) {
    const node = findNode(entry.node, nodeId);
    if (node) return node;
  }
  return undefined;
}

export function workspacePanelIds(layout: WorkspaceLayout): readonly string[] {
  return [
    ...(layout.root ? nodePanelIds(layout.root) : []),
    ...layout.floating.flatMap((entry) => nodePanelIds(entry.node)),
  ];
}

export function workspaceTabGroups(layout: WorkspaceLayout): readonly WorkspaceGroupLocation[] {
  const groups: WorkspaceGroupLocation[] = [];
  if (layout.root) collectTabGroups(layout.root, groups);
  for (const entry of layout.floating) collectTabGroups(entry.node, groups, entry.id);
  return groups;
}

function normalizeNode(node: WorkspaceNode, context: NormalizeContext): WorkspaceNode | null {
  if (node.kind === "tabGroup") {
    const panels: string[] = [];
    for (const panelId of node.panels) {
      if (!validId(panelId) || context.panelIds.has(panelId)) continue;
      context.panelIds.add(panelId);
      panels.push(panelId);
    }
    if (panels.length === 0) return null;
    const activePanelId = panels.includes(node.activePanelId) ? node.activePanelId : panels[0];
    return sameStringArray(panels, node.panels) && activePanelId === node.activePanelId
      ? node
      : { ...node, panels, activePanelId };
  }
  const first = normalizeNode(node.first, context);
  const second = normalizeNode(node.second, context);
  if (!first) return second;
  if (!second) return first;
  const ratio = clampSplitRatio(node.ratio);
  return first === node.first && second === node.second && ratio === node.ratio
    ? node
    : { ...node, first, second, ratio };
}

function detachVisiblePanel(
  layout: WorkspaceLayout,
  panelId: string,
): { readonly layout: WorkspaceLayout; readonly removed: boolean } {
  if (layout.root) {
    const result = removePanelFromNode(layout.root, panelId);
    if (result.removed) return { layout: { ...layout, root: result.node }, removed: true };
  }
  for (let index = 0; index < layout.floating.length; index += 1) {
    const entry = layout.floating[index];
    const result = removePanelFromNode(entry.node, panelId);
    if (!result.removed) continue;
    const floating = [...layout.floating];
    if (result.node) floating[index] = { ...entry, node: result.node };
    else floating.splice(index, 1);
    return { layout: { ...layout, floating }, removed: true };
  }
  return { layout, removed: false };
}

function detachWorkspaceNode(
  layout: WorkspaceLayout,
  nodeId: string,
): { readonly layout: WorkspaceLayout; readonly node: WorkspaceNode | null } {
  if (layout.root) {
    const result = removeNodeById(layout.root, nodeId);
    if (result.removed) return { layout: { ...layout, root: result.node }, node: result.detached };
  }
  for (let index = 0; index < layout.floating.length; index += 1) {
    const entry = layout.floating[index];
    const result = removeNodeById(entry.node, nodeId);
    if (!result.removed) continue;
    const floating = [...layout.floating];
    if (result.node) floating[index] = { ...entry, node: result.node };
    else floating.splice(index, 1);
    return { layout: { ...layout, floating }, node: result.detached };
  }
  return { layout, node: null };
}

function removeNodeById(
  node: WorkspaceNode,
  nodeId: string,
): NodeResult & { readonly detached: WorkspaceNode | null } {
  if (node.id === nodeId) return { node: null, removed: true, detached: node };
  if (node.kind === "tabGroup") return { node, removed: false, detached: null };
  const first = removeNodeById(node.first, nodeId);
  if (first.removed) {
    if (!first.node) return { node: node.second, removed: true, detached: first.detached };
    return { node: { ...node, first: first.node }, removed: true, detached: first.detached };
  }
  const second = removeNodeById(node.second, nodeId);
  if (!second.removed) return { node, removed: false, detached: null };
  if (!second.node) return { node: node.first, removed: true, detached: second.detached };
  return { node: { ...node, second: second.node }, removed: true, detached: second.detached };
}

function removePanelFromNode(node: WorkspaceNode, panelId: string): NodeResult {
  if (node.kind === "tabGroup") {
    const index = node.panels.indexOf(panelId);
    if (index < 0) return { node, removed: false };
    const panels = node.panels.filter((candidate) => candidate !== panelId);
    if (panels.length === 0) return { node: null, removed: true };
    const activePanelId =
      node.activePanelId === panelId
        ? panels[Math.min(index, panels.length - 1)]
        : node.activePanelId;
    return { node: { ...node, panels, activePanelId }, removed: true };
  }
  const first = removePanelFromNode(node.first, panelId);
  if (first.removed) {
    if (!first.node) return { node: node.second, removed: true };
    return { node: { ...node, first: first.node }, removed: true };
  }
  const second = removePanelFromNode(node.second, panelId);
  if (!second.removed) return { node, removed: false };
  if (!second.node) return { node: node.first, removed: true };
  return { node: { ...node, second: second.node }, removed: true };
}

function replaceNodeInLayout(
  layout: WorkspaceLayout,
  nodeId: string,
  replace: (node: WorkspaceNode) => WorkspaceNode,
): WorkspaceLayout | undefined {
  if (layout.root) {
    const result = replaceNode(layout.root, nodeId, replace);
    if (result.found)
      return result.node === layout.root ? layout : { ...layout, root: result.node };
  }
  for (let index = 0; index < layout.floating.length; index += 1) {
    const entry = layout.floating[index];
    const result = replaceNode(entry.node, nodeId, replace);
    if (!result.found) continue;
    if (result.node === entry.node) return layout;
    const floating = [...layout.floating];
    floating[index] = { ...entry, node: result.node };
    return { ...layout, floating };
  }
  return undefined;
}

function replaceNode(
  node: WorkspaceNode,
  nodeId: string,
  replace: (node: WorkspaceNode) => WorkspaceNode,
): ReplaceResult {
  if (node.id === nodeId) return { node: replace(node), found: true };
  if (node.kind === "tabGroup") return { node, found: false };
  const first = replaceNode(node.first, nodeId, replace);
  if (first.found)
    return {
      node: first.node === node.first ? node : { ...node, first: first.node },
      found: true,
    };
  const second = replaceNode(node.second, nodeId, replace);
  return second.found
    ? {
        node: second.node === node.second ? node : { ...node, second: second.node },
        found: true,
      }
    : { node, found: false };
}

function removeClosedPanel(layout: WorkspaceLayout, panelId: string): WorkspaceLayout {
  if (!layout.closedPanels.includes(panelId)) return layout;
  return {
    ...layout,
    closedPanels: layout.closedPanels.filter((candidate) => candidate !== panelId),
  };
}

function findNode(node: WorkspaceNode, nodeId: string): WorkspaceNode | undefined {
  if (node.id === nodeId) return node;
  if (node.kind === "tabGroup") return undefined;
  return findNode(node.first, nodeId) ?? findNode(node.second, nodeId);
}

function firstTabGroupId(node: WorkspaceNode): string {
  return node.kind === "tabGroup" ? node.id : firstTabGroupId(node.first);
}

function nodePanelIds(node: WorkspaceNode): string[] {
  return node.kind === "tabGroup"
    ? [...node.panels]
    : [...nodePanelIds(node.first), ...nodePanelIds(node.second)];
}

function nodeHasPanel(node: WorkspaceNode, panelId: string): boolean {
  return node.kind === "tabGroup"
    ? node.panels.includes(panelId)
    : nodeHasPanel(node.first, panelId) || nodeHasPanel(node.second, panelId);
}

function nextLayoutId(layout: WorkspaceLayout, prefix: string): string {
  const ids = new Set<string>();
  if (layout.root) collectNodeIds(layout.root, ids);
  for (const entry of layout.floating) {
    ids.add(entry.id);
    collectNodeIds(entry.node, ids);
  }
  let index = 1;
  while (ids.has(`${prefix}-${index}`)) index += 1;
  return `${prefix}-${index}`;
}

function collectNodeIds(node: WorkspaceNode, ids: Set<string>): void {
  ids.add(node.id);
  if (node.kind === "split") {
    collectNodeIds(node.first, ids);
    collectNodeIds(node.second, ids);
  }
}

function collectTabGroups(
  node: WorkspaceNode,
  groups: WorkspaceGroupLocation[],
  floatingId?: string,
): void {
  if (node.kind === "tabGroup") {
    groups.push({ group: node, ...(floatingId ? { floatingId } : {}) });
    return;
  }
  collectTabGroups(node.first, groups, floatingId);
  collectTabGroups(node.second, groups, floatingId);
}

function normalizeBounds(bounds: WorkspaceBounds): WorkspaceBounds {
  return {
    x: clampFinite(bounds.x, -MAX_FLOATING_COORDINATE, MAX_FLOATING_COORDINATE, 0),
    y: clampFinite(bounds.y, -MAX_FLOATING_COORDINATE, MAX_FLOATING_COORDINATE, 0),
    width: clampFinite(bounds.width, MIN_FLOATING_WIDTH, MAX_FLOATING_DIMENSION, 640),
    height: clampFinite(bounds.height, MIN_FLOATING_HEIGHT, MAX_FLOATING_DIMENSION, 480),
  };
}

function clampSplitRatio(ratio: number): number {
  return clampFinite(ratio, MIN_SPLIT_RATIO, MAX_SPLIT_RATIO, 0.5);
}

function clampFinite(value: number, minimum: number, maximum: number, fallback: number): number {
  return Math.max(minimum, Math.min(maximum, Number.isFinite(value) ? value : fallback));
}

function normalizeOptionalId(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim();
  return normalized || undefined;
}

function validId(value: string): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

function compareIds(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sameStringArray(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sameBounds(left: WorkspaceBounds, right: WorkspaceBounds): boolean {
  return (
    left.x === right.x &&
    left.y === right.y &&
    left.width === right.width &&
    left.height === right.height
  );
}
