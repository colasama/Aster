import {
  type FloatingWorkspace,
  normalizeWorkspaceLayout,
  type WorkspaceBounds,
  type WorkspaceLayout,
  type WorkspaceNode,
  type WorkspaceViewerInstance,
} from "./layout";

export const CURRENT_WORKSPACE_LAYOUT_VERSION = 2 as const;

export interface WorkspaceLayoutDocument {
  readonly schemaVersion: typeof CURRENT_WORKSPACE_LAYOUT_VERSION;
  readonly root: WorkspaceNode | null;
  readonly floating: readonly FloatingWorkspace[];
  readonly closedPanels: readonly string[];
  readonly maximizedGroupId?: string;
  readonly viewers: readonly WorkspaceViewerInstance[];
}

const MAX_NODES = 256;
const MAX_DEPTH = 32;
const MAX_PANELS = 512;
const MAX_FLOATING_WORKSPACES = 32;
const MAX_ID_LENGTH = 256;
const MAX_ABSOLUTE_COORDINATE = 10_000_000;
const MAX_DIMENSION = 1_000_000;

interface DecodeState {
  nodeCount: number;
  panelCount: number;
  readonly nodeIds: Set<string>;
  readonly floatingIds: Set<string>;
}

class InvalidWorkspaceLayout extends Error {}

/** Creates a detached, current-version persistence document. */
export function serializeWorkspaceLayout(layout: WorkspaceLayout): WorkspaceLayoutDocument {
  const normalized = normalizeWorkspaceLayout(layout);
  return {
    schemaVersion: CURRENT_WORKSPACE_LAYOUT_VERSION,
    root: normalized.root ? cloneNode(normalized.root) : null,
    floating: normalized.floating.map((entry) => ({
      id: entry.id,
      node: cloneNode(entry.node),
      bounds: { ...entry.bounds },
      ...(entry.displayId ? { displayId: entry.displayId } : {}),
    })),
    closedPanels: [...normalized.closedPanels],
    ...(normalized.maximizedGroupId ? { maximizedGroupId: normalized.maximizedGroupId } : {}),
    viewers: (normalized.viewers ?? []).map((viewer) => ({
      id: viewer.id,
      sourcePanelId: viewer.sourcePanelId,
      viewerType: viewer.viewerType,
      // Adobe does not persist project-bound locked viewers in workspace preferences.
      locked: false,
    })),
  };
}

/**
 * Reads a persisted layout through the migration and validation boundary.
 * Any malformed, over-sized, or future-version document returns the supplied safe layout.
 */
export function deserializeWorkspaceLayout(
  value: unknown,
  fallback: WorkspaceLayout,
): WorkspaceLayout {
  const normalizedFallback = normalizeWorkspaceLayout(fallback);
  try {
    const document = migrateDocument(value);
    const state: DecodeState = {
      nodeCount: 0,
      panelCount: 0,
      nodeIds: new Set(),
      floatingIds: new Set(),
    };
    const rootValue = document.root;
    const root = rootValue === null ? null : decodeNode(rootValue, state, 0);
    const floatingValue = requireArray(document.floating, "floating");
    if (floatingValue.length > MAX_FLOATING_WORKSPACES)
      throw new InvalidWorkspaceLayout("Too many floating workspaces");
    const floating = floatingValue.map((entry, index) => decodeFloating(entry, state, index));
    const closedValue = requireArray(document.closedPanels, "closedPanels");
    if (closedValue.length > MAX_PANELS) throw new InvalidWorkspaceLayout("Too many closed panels");
    const closedPanels = closedValue.map((panelId, index) =>
      requireId(panelId, `closedPanels[${index}]`),
    );
    const maximizedGroupId =
      document.maximizedGroupId === undefined
        ? undefined
        : requireId(document.maximizedGroupId, "maximizedGroupId");
    const viewersValue = requireArray(document.viewers, "viewers");
    if (viewersValue.length > MAX_PANELS) throw new InvalidWorkspaceLayout("Too many viewers");
    const viewers = viewersValue.map((viewer, index) => decodeViewer(viewer, index));
    return normalizeWorkspaceLayout({
      root,
      floating,
      closedPanels,
      ...(maximizedGroupId ? { maximizedGroupId } : {}),
      ...(viewers.length > 0 ? { viewers } : {}),
    });
  } catch {
    return normalizedFallback;
  }
}

function migrateDocument(value: unknown): Record<string, unknown> {
  const source = requireRecord(value, "workspace layout");
  const version = source.schemaVersion ?? 0;
  if (!Number.isSafeInteger(version) || Number(version) < 0)
    throw new InvalidWorkspaceLayout("Invalid workspace schema version");
  if (Number(version) > CURRENT_WORKSPACE_LAYOUT_VERSION)
    throw new InvalidWorkspaceLayout("Future workspace schema version");
  if (Number(version) <= 1) return { ...source, schemaVersion: 2, viewers: source.viewers ?? [] };
  return source;
}

function decodeNode(value: unknown, state: DecodeState, depth: number): WorkspaceNode {
  if (depth > MAX_DEPTH) throw new InvalidWorkspaceLayout("Workspace layout is too deep");
  state.nodeCount += 1;
  if (state.nodeCount > MAX_NODES) throw new InvalidWorkspaceLayout("Too many workspace nodes");
  const source = requireRecord(value, "workspace node");
  const id = requireId(source.id, "workspace node id");
  if (state.nodeIds.has(id)) throw new InvalidWorkspaceLayout("Duplicate workspace node id");
  state.nodeIds.add(id);
  if (source.kind === "tabGroup") {
    const panelsValue = requireArray(source.panels, `tab group ${id}.panels`);
    if (panelsValue.length === 0) throw new InvalidWorkspaceLayout("Empty tab group");
    state.panelCount += panelsValue.length;
    if (state.panelCount > MAX_PANELS)
      throw new InvalidWorkspaceLayout("Too many workspace panels");
    const panels = panelsValue.map((panelId, index) =>
      requireId(panelId, `tab group ${id}.panels[${index}]`),
    );
    const activePanelId = requireId(source.activePanelId, `tab group ${id}.activePanelId`);
    if (!panels.includes(activePanelId))
      throw new InvalidWorkspaceLayout("The active panel is not in its tab group");
    const presentation = source.presentation === undefined ? undefined : source.presentation;
    if (presentation !== undefined && presentation !== "tabs" && presentation !== "stacked")
      throw new InvalidWorkspaceLayout("Invalid tab group presentation");
    if (presentation !== "stacked") return { kind: "tabGroup", id, panels, activePanelId };
    if (source.stackSolo !== undefined && typeof source.stackSolo !== "boolean")
      throw new InvalidWorkspaceLayout("Invalid stack solo state");
    const expandedValue = requireArray(source.expandedPanelIds ?? [], `tab group ${id}.expanded`);
    if (expandedValue.length > panels.length)
      throw new InvalidWorkspaceLayout("Too many expanded stack panels");
    const expandedPanelIds = expandedValue.map((panelId, index) =>
      requireId(panelId, `tab group ${id}.expanded[${index}]`),
    );
    if (expandedPanelIds.some((panelId) => !panels.includes(panelId)))
      throw new InvalidWorkspaceLayout("Expanded stack panel is not in its group");
    return {
      kind: "tabGroup",
      id,
      panels,
      activePanelId,
      presentation: "stacked",
      stackSolo: source.stackSolo !== false,
      expandedPanelIds,
    };
  }
  if (source.kind !== "split") throw new InvalidWorkspaceLayout("Unknown workspace node kind");
  if (source.axis !== "horizontal" && source.axis !== "vertical")
    throw new InvalidWorkspaceLayout("Invalid split axis");
  const ratio = requireFiniteNumber(source.ratio, `split ${id}.ratio`);
  if (ratio < 0 || ratio > 1) throw new InvalidWorkspaceLayout("Invalid split ratio");
  return {
    kind: "split",
    id,
    axis: source.axis,
    ratio,
    first: decodeNode(source.first, state, depth + 1),
    second: decodeNode(source.second, state, depth + 1),
  };
}

function decodeViewer(value: unknown, index: number): WorkspaceViewerInstance {
  const source = requireRecord(value, `viewers[${index}]`);
  if (typeof source.locked !== "boolean")
    throw new InvalidWorkspaceLayout(`viewers[${index}].locked must be a boolean`);
  const contextId =
    source.contextId === undefined
      ? undefined
      : requireId(source.contextId, `viewers[${index}].contextId`);
  return {
    id: requireId(source.id, `viewers[${index}].id`),
    sourcePanelId: requireId(source.sourcePanelId, `viewers[${index}].sourcePanelId`),
    viewerType: requireId(source.viewerType, `viewers[${index}].viewerType`),
    locked: source.locked,
    ...(source.locked && contextId ? { contextId } : {}),
  };
}

function decodeFloating(value: unknown, state: DecodeState, index: number): FloatingWorkspace {
  const source = requireRecord(value, `floating[${index}]`);
  const id = requireId(source.id, `floating[${index}].id`);
  if (state.floatingIds.has(id))
    throw new InvalidWorkspaceLayout("Duplicate floating workspace id");
  state.floatingIds.add(id);
  const bounds = decodeBounds(source.bounds, `floating[${index}].bounds`);
  const displayId =
    source.displayId === undefined
      ? undefined
      : requireId(source.displayId, `floating[${index}].displayId`);
  return {
    id,
    node: decodeNode(source.node, state, 0),
    bounds,
    ...(displayId ? { displayId } : {}),
  };
}

function decodeBounds(value: unknown, path: string): WorkspaceBounds {
  const source = requireRecord(value, path);
  const x = requireFiniteNumber(source.x, `${path}.x`);
  const y = requireFiniteNumber(source.y, `${path}.y`);
  const width = requireFiniteNumber(source.width, `${path}.width`);
  const height = requireFiniteNumber(source.height, `${path}.height`);
  if (
    Math.abs(x) > MAX_ABSOLUTE_COORDINATE ||
    Math.abs(y) > MAX_ABSOLUTE_COORDINATE ||
    width <= 0 ||
    height <= 0 ||
    width > MAX_DIMENSION ||
    height > MAX_DIMENSION
  )
    throw new InvalidWorkspaceLayout(`Invalid ${path}`);
  return { x, y, width, height };
}

function cloneNode(node: WorkspaceNode): WorkspaceNode {
  return node.kind === "tabGroup"
    ? {
        ...node,
        panels: [...node.panels],
        ...(node.expandedPanelIds ? { expandedPanelIds: [...node.expandedPanelIds] } : {}),
      }
    : {
        ...node,
        first: cloneNode(node.first),
        second: cloneNode(node.second),
      };
}

function requireRecord(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new InvalidWorkspaceLayout(`${path} must be an object`);
  return value as Record<string, unknown>;
}

function requireArray(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) throw new InvalidWorkspaceLayout(`${path} must be an array`);
  return value;
}

function requireId(value: unknown, path: string): string {
  if (typeof value !== "string") throw new InvalidWorkspaceLayout(`${path} must be a string`);
  const id = value.trim();
  if (!id || id.length > MAX_ID_LENGTH) throw new InvalidWorkspaceLayout(`Invalid ${path}`);
  return id;
}

function requireFiniteNumber(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value))
    throw new InvalidWorkspaceLayout(`${path} must be finite`);
  return value;
}
