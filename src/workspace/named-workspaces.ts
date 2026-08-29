import { DEFAULT_WORKSPACE_LAYOUT } from "./default-layout";
import type { WorkspaceLayout } from "./layout";
import { deserializeWorkspaceLayout, serializeWorkspaceLayout } from "./layout-schema";
import type { WorkspaceStorage } from "./layout-storage";

export const WORKSPACE_CATALOG_STORAGE_KEY = "aster.workspace.catalog.v1";
export const CURRENT_WORKSPACE_CATALOG_VERSION = 1 as const;

export type BuiltInWorkspaceId = "default" | "animation" | "minimal";

export interface NamedWorkspace {
  readonly id: string;
  readonly name: string;
  readonly layout: WorkspaceLayout;
  readonly builtIn: boolean;
}

export interface WorkspaceCatalog {
  readonly currentWorkspaceId: string;
  readonly workspaces: readonly NamedWorkspace[];
}

const ANIMATION_WORKSPACE_LAYOUT: WorkspaceLayout = {
  ...DEFAULT_WORKSPACE_LAYOUT,
  root: {
    kind: "split",
    id: "animation-root",
    axis: "horizontal",
    ratio: 0.16,
    first: {
      kind: "tabGroup",
      id: "animation-project",
      panels: ["project"],
      activePanelId: "project",
    },
    second: {
      kind: "split",
      id: "animation-main",
      axis: "vertical",
      ratio: 0.58,
      first: {
        kind: "split",
        id: "animation-top",
        axis: "horizontal",
        ratio: 0.74,
        first: {
          kind: "tabGroup",
          id: "animation-viewer",
          panels: ["viewport", "profiler"],
          activePanelId: "viewport",
        },
        second: {
          kind: "tabGroup",
          id: "animation-inspector",
          panels: ["inspector"],
          activePanelId: "inspector",
        },
      },
      second: {
        kind: "tabGroup",
        id: "animation-graph",
        panels: ["graph", "timeline"],
        activePanelId: "graph",
      },
    },
  },
};

const MINIMAL_WORKSPACE_LAYOUT: WorkspaceLayout = {
  root: {
    kind: "tabGroup",
    id: "minimal-viewer",
    panels: ["viewport"],
    activePanelId: "viewport",
  },
  floating: [],
  closedPanels: ["graph", "inspector", "profiler", "project", "timeline"],
};

export const BUILT_IN_WORKSPACES: readonly NamedWorkspace[] = [
  { id: "default", name: "Default", layout: DEFAULT_WORKSPACE_LAYOUT, builtIn: true },
  { id: "animation", name: "Animation", layout: ANIMATION_WORKSPACE_LAYOUT, builtIn: true },
  { id: "minimal", name: "Minimal", layout: MINIMAL_WORKSPACE_LAYOUT, builtIn: true },
];

export function createWorkspaceCatalog(): WorkspaceCatalog {
  return { currentWorkspaceId: "default", workspaces: BUILT_IN_WORKSPACES };
}

export function workspaceById(
  catalog: WorkspaceCatalog,
  workspaceId: string,
): NamedWorkspace | undefined {
  return catalog.workspaces.find((workspace) => workspace.id === workspaceId);
}

export function selectWorkspace(catalog: WorkspaceCatalog, workspaceId: string): WorkspaceCatalog {
  if (workspaceId === catalog.currentWorkspaceId || !workspaceById(catalog, workspaceId))
    return catalog;
  return { ...catalog, currentWorkspaceId: workspaceId };
}

export function saveWorkspaceAs(
  catalog: WorkspaceCatalog,
  desiredName: string,
  layout: WorkspaceLayout,
): WorkspaceCatalog {
  const name = uniqueWorkspaceName(catalog, desiredName);
  const id = nextWorkspaceId(catalog, name);
  return {
    currentWorkspaceId: id,
    workspaces: [
      ...catalog.workspaces,
      { id, name, layout: snapshotWorkspaceLayout(layout), builtIn: false },
    ],
  };
}

export function renameWorkspace(
  catalog: WorkspaceCatalog,
  workspaceId: string,
  desiredName: string,
): WorkspaceCatalog {
  const workspace = workspaceById(catalog, workspaceId);
  if (!workspace || workspace.builtIn) return catalog;
  const name = uniqueWorkspaceName(catalog, desiredName, workspaceId);
  if (name === workspace.name) return catalog;
  return {
    ...catalog,
    workspaces: catalog.workspaces.map((candidate) =>
      candidate.id === workspaceId ? { ...candidate, name } : candidate,
    ),
  };
}

export function deleteWorkspace(catalog: WorkspaceCatalog, workspaceId: string): WorkspaceCatalog {
  const workspace = workspaceById(catalog, workspaceId);
  if (!workspace || workspace.builtIn) return catalog;
  return {
    currentWorkspaceId:
      catalog.currentWorkspaceId === workspaceId ? "default" : catalog.currentWorkspaceId,
    workspaces: catalog.workspaces.filter((candidate) => candidate.id !== workspaceId),
  };
}

export function uniqueWorkspaceName(
  catalog: WorkspaceCatalog,
  desiredName: string,
  excludeWorkspaceId?: string,
): string {
  const base = normalizeWorkspaceName(desiredName);
  const names = new Set(
    catalog.workspaces
      .filter((workspace) => workspace.id !== excludeWorkspaceId)
      .map((workspace) => workspace.name.toLocaleLowerCase()),
  );
  if (!names.has(base.toLocaleLowerCase())) return base;
  let suffix = 2;
  while (names.has(`${base} ${suffix}`.toLocaleLowerCase())) suffix += 1;
  return `${base} ${suffix}`;
}

export function loadWorkspaceCatalog(
  storage: WorkspaceStorage | undefined = browserStorage(),
): WorkspaceCatalog {
  const fallback = createWorkspaceCatalog();
  if (!storage) return fallback;
  try {
    const raw = storage.getItem(WORKSPACE_CATALOG_STORAGE_KEY);
    if (!raw) return fallback;
    const value = JSON.parse(raw) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) return fallback;
    const source = value as Record<string, unknown>;
    if (source.schemaVersion !== CURRENT_WORKSPACE_CATALOG_VERSION) return fallback;
    if (!Array.isArray(source.customWorkspaces) || source.customWorkspaces.length > 64)
      return fallback;
    const workspaces: NamedWorkspace[] = [...BUILT_IN_WORKSPACES];
    const ids = new Set(workspaces.map((workspace) => workspace.id));
    const names = new Set(workspaces.map((workspace) => workspace.name.toLocaleLowerCase()));
    for (const entry of source.customWorkspaces) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) return fallback;
      const record = entry as Record<string, unknown>;
      const id = validText(record.id, 128);
      const name = validText(record.name, 80);
      if (!id || !name || ids.has(id) || names.has(name.toLocaleLowerCase())) return fallback;
      const layout = deserializeWorkspaceLayout(record.layout, DEFAULT_WORKSPACE_LAYOUT);
      ids.add(id);
      names.add(name.toLocaleLowerCase());
      workspaces.push({ id, name, layout, builtIn: false });
    }
    const currentWorkspaceId = validText(source.currentWorkspaceId, 128);
    return {
      currentWorkspaceId:
        currentWorkspaceId && ids.has(currentWorkspaceId) ? currentWorkspaceId : "default",
      workspaces,
    };
  } catch {
    return fallback;
  }
}

export function saveWorkspaceCatalog(
  catalog: WorkspaceCatalog,
  storage: WorkspaceStorage | undefined = browserStorage(),
): boolean {
  if (!storage) return false;
  try {
    storage.setItem(
      WORKSPACE_CATALOG_STORAGE_KEY,
      JSON.stringify({
        schemaVersion: CURRENT_WORKSPACE_CATALOG_VERSION,
        currentWorkspaceId: catalog.currentWorkspaceId,
        customWorkspaces: catalog.workspaces
          .filter((workspace) => !workspace.builtIn)
          .map((workspace) => ({
            id: workspace.id,
            name: workspace.name,
            layout: serializeWorkspaceLayout(workspace.layout),
          })),
      }),
    );
    return true;
  } catch {
    return false;
  }
}

function snapshotWorkspaceLayout(layout: WorkspaceLayout): WorkspaceLayout {
  return deserializeWorkspaceLayout(serializeWorkspaceLayout(layout), DEFAULT_WORKSPACE_LAYOUT);
}

function normalizeWorkspaceName(value: string): string {
  return value.trim().replace(/\s+/g, " ").slice(0, 80) || "Workspace";
}

function nextWorkspaceId(catalog: WorkspaceCatalog, name: string): string {
  const slug =
    name
      .normalize("NFKD")
      .toLocaleLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "workspace";
  const ids = new Set(catalog.workspaces.map((workspace) => workspace.id));
  let suffix = 1;
  while (ids.has(`custom-${slug}-${suffix}`)) suffix += 1;
  return `custom-${slug}-${suffix}`;
}

function validText(value: unknown, maximumLength: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const result = value.trim();
  return result && result.length <= maximumLength ? result : undefined;
}

function browserStorage(): Storage | undefined {
  if (typeof window === "undefined") return undefined;
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}
