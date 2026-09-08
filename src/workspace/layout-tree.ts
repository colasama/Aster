import type {
  FloatingWorkspace,
  WorkspaceGroupLocation,
  WorkspaceLayout,
  WorkspaceNode,
} from "./layout-types";

interface NodeResult {
  readonly node: WorkspaceNode | null;
  readonly removed: boolean;
}

interface ReplaceResult {
  readonly node: WorkspaceNode;
  readonly found: boolean;
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

export function detachVisiblePanel(
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

export function detachWorkspaceNode(
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

export function replaceNodeInLayout(
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

export function removeClosedPanel(layout: WorkspaceLayout, panelId: string): WorkspaceLayout {
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

export function firstTabGroupId(node: WorkspaceNode): string {
  return node.kind === "tabGroup" ? node.id : firstTabGroupId(node.first);
}

export function nodePanelIds(node: WorkspaceNode): string[] {
  return node.kind === "tabGroup"
    ? [...node.panels]
    : [...nodePanelIds(node.first), ...nodePanelIds(node.second)];
}

export function nodeHasPanel(node: WorkspaceNode, panelId: string): boolean {
  return node.kind === "tabGroup"
    ? node.panels.includes(panelId)
    : nodeHasPanel(node.first, panelId) || nodeHasPanel(node.second, panelId);
}

export function nextLayoutId(layout: WorkspaceLayout, prefix: string): string {
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

export function withoutMaximizedGroup(layout: WorkspaceLayout): WorkspaceLayout {
  const { maximizedGroupId: _maximized, ...rest } = layout;
  return rest;
}

export function findNodeInRoots(
  root: WorkspaceNode | null,
  floating: readonly FloatingWorkspace[],
  nodeId: string,
): WorkspaceNode | undefined {
  const docked = root ? findNode(root, nodeId) : undefined;
  if (docked) return docked;
  for (const entry of floating) {
    const candidate = findNode(entry.node, nodeId);
    if (candidate) return candidate;
  }
  return undefined;
}

export function nextViewerId(layout: WorkspaceLayout, sourcePanelId: string): string {
  const panelIds = new Set([
    ...workspacePanelIds(layout),
    ...layout.closedPanels,
    ...(layout.viewers ?? []).map((viewer) => viewer.id),
  ]);
  let index = 2;
  while (panelIds.has(`${sourcePanelId}::viewer-${index}`)) index += 1;
  return `${sourcePanelId}::viewer-${index}`;
}

export function viewerInstanceCount(layout: WorkspaceLayout, sourcePanelId: string): number {
  const retainedPanelIds = new Set([...workspacePanelIds(layout), ...layout.closedPanels]);
  const viewerSources = new Map(
    (layout.viewers ?? []).map((viewer) => [viewer.id, viewer.sourcePanelId]),
  );
  let count = 0;
  for (const panelId of retainedPanelIds)
    if ((viewerSources.get(panelId) ?? panelId) === sourcePanelId) count += 1;
  return count;
}
