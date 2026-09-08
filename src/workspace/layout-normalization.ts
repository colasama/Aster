import { findNodeInRoots } from "./layout-tree";
import {
  type FloatingWorkspace,
  MAX_SPLIT_RATIO,
  MIN_SPLIT_RATIO,
  type WorkspaceBounds,
  type WorkspaceGroupPresentation,
  type WorkspaceLayout,
  type WorkspaceNode,
  type WorkspaceTabGroup,
  type WorkspaceViewerInstance,
} from "./layout-types";

const MIN_FLOATING_WIDTH = 160;

const MIN_FLOATING_HEIGHT = 120;

const MAX_FLOATING_DIMENSION = 100_000;

const MAX_FLOATING_COORDINATE = 1_000_000;

interface NormalizeContext {
  readonly panelIds: Set<string>;
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
  const maximizedGroupId =
    layout.maximizedGroupId &&
    findNodeInRoots(root, floating, layout.maximizedGroupId)?.kind === "tabGroup"
      ? layout.maximizedGroupId
      : undefined;
  const viewers = normalizeViewers(layout.viewers ?? [], context.panelIds, closedPanels);
  const viewersChanged = !sameViewers(viewers, layout.viewers ?? []);
  const rootChanged = root !== layout.root;
  if (
    !rootChanged &&
    !floatingChanged &&
    !closedChanged &&
    maximizedGroupId === layout.maximizedGroupId &&
    !viewersChanged
  )
    return layout;
  return {
    root,
    floating: floatingChanged ? floating : layout.floating,
    closedPanels: closedChanged ? closedPanels : layout.closedPanels,
    ...(maximizedGroupId ? { maximizedGroupId } : {}),
    ...(viewers.length > 0 ? { viewers: viewersChanged ? viewers : layout.viewers } : {}),
  };
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
    const presentation: WorkspaceGroupPresentation =
      node.presentation === "stacked" ? "stacked" : "tabs";
    if (presentation === "tabs") {
      const hasStackMetadata =
        node.presentation !== undefined ||
        node.stackSolo !== undefined ||
        node.expandedPanelIds !== undefined;
      return sameStringArray(panels, node.panels) &&
        activePanelId === node.activePanelId &&
        !hasStackMetadata
        ? node
        : { kind: "tabGroup", id: node.id, panels, activePanelId };
    }
    const stackSolo = node.stackSolo ?? true;
    const candidate: WorkspaceTabGroup = { ...node, panels, activePanelId };
    const expanded = normalizedExpandedPanels(candidate, node.expandedPanelIds);
    const expandedPanelIds = stackSolo && expanded.length > 1 ? [activePanelId] : expanded;
    return sameStringArray(panels, node.panels) &&
      activePanelId === node.activePanelId &&
      node.presentation === presentation &&
      node.stackSolo === stackSolo &&
      sameStringArray(expandedPanelIds, node.expandedPanelIds ?? [])
      ? node
      : { ...node, panels, activePanelId, presentation, stackSolo, expandedPanelIds };
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

export function normalizeBounds(bounds: WorkspaceBounds): WorkspaceBounds {
  return {
    x: clampFinite(bounds.x, -MAX_FLOATING_COORDINATE, MAX_FLOATING_COORDINATE, 0),
    y: clampFinite(bounds.y, -MAX_FLOATING_COORDINATE, MAX_FLOATING_COORDINATE, 0),
    width: clampFinite(bounds.width, MIN_FLOATING_WIDTH, MAX_FLOATING_DIMENSION, 640),
    height: clampFinite(bounds.height, MIN_FLOATING_HEIGHT, MAX_FLOATING_DIMENSION, 480),
  };
}

export function clampSplitRatio(ratio: number): number {
  return clampFinite(ratio, MIN_SPLIT_RATIO, MAX_SPLIT_RATIO, 0.5);
}

function clampFinite(value: number, minimum: number, maximum: number, fallback: number): number {
  return Math.max(minimum, Math.min(maximum, Number.isFinite(value) ? value : fallback));
}

export function normalizeOptionalId(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim();
  return normalized || undefined;
}

export function validId(value: string): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

export function compareIds(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sameStringArray(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export function sameBounds(left: WorkspaceBounds, right: WorkspaceBounds): boolean {
  return (
    left.x === right.x &&
    left.y === right.y &&
    left.width === right.width &&
    left.height === right.height
  );
}

export function normalizedExpandedPanels(
  group: WorkspaceTabGroup,
  values: readonly string[] | undefined,
): readonly string[] {
  const expanded = new Set(values?.filter((panelId) => group.panels.includes(panelId)) ?? []);
  return group.panels.filter((panelId) => expanded.has(panelId));
}

function normalizeViewers(
  viewers: readonly WorkspaceViewerInstance[],
  visiblePanelIds: ReadonlySet<string>,
  closedPanelIds: readonly string[],
): readonly WorkspaceViewerInstance[] {
  const retainedPanelIds = new Set([...visiblePanelIds, ...closedPanelIds]);
  const ids = new Set<string>();
  const normalized: WorkspaceViewerInstance[] = [];
  for (const viewer of viewers) {
    if (
      !validId(viewer.id) ||
      !validId(viewer.sourcePanelId) ||
      !validId(viewer.viewerType) ||
      ids.has(viewer.id) ||
      !retainedPanelIds.has(viewer.id)
    )
      continue;
    ids.add(viewer.id);
    normalized.push({
      id: viewer.id.trim(),
      sourcePanelId: viewer.sourcePanelId.trim(),
      viewerType: viewer.viewerType.trim(),
      locked: viewer.locked === true,
      ...(viewer.locked === true && validId(viewer.contextId ?? "")
        ? { contextId: viewer.contextId?.trim() }
        : {}),
    });
  }
  return normalized;
}

function sameViewers(
  left: readonly WorkspaceViewerInstance[],
  right: readonly WorkspaceViewerInstance[],
): boolean {
  return (
    left.length === right.length && left.every((viewer, index) => sameViewer(viewer, right[index]))
  );
}

export function sameViewer(
  left: WorkspaceViewerInstance,
  right: WorkspaceViewerInstance | undefined,
): boolean {
  return Boolean(
    right &&
      left.id === right.id &&
      left.sourcePanelId === right.sourcePanelId &&
      left.viewerType === right.viewerType &&
      left.locked === right.locked &&
      left.contextId === right.contextId,
  );
}
