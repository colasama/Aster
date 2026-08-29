import type { WorkspaceLayout } from "./layout";
import { deserializeWorkspaceLayout, serializeWorkspaceLayout } from "./layout-schema";

export const WORKSPACE_LAYOUT_STORAGE_KEY = "aster.workspace.layout.v1";

export interface WorkspaceStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function loadWorkspaceLayout(
  fallback: WorkspaceLayout,
  storage: WorkspaceStorage | undefined = browserStorage(),
): WorkspaceLayout {
  if (!storage) return fallback;
  try {
    const value = storage.getItem(WORKSPACE_LAYOUT_STORAGE_KEY);
    return value === null ? fallback : deserializeWorkspaceLayout(JSON.parse(value), fallback);
  } catch {
    return fallback;
  }
}

export function saveWorkspaceLayout(
  layout: WorkspaceLayout,
  storage: WorkspaceStorage | undefined = browserStorage(),
): boolean {
  if (!storage) return false;
  try {
    storage.setItem(WORKSPACE_LAYOUT_STORAGE_KEY, JSON.stringify(serializeWorkspaceLayout(layout)));
    return true;
  } catch {
    return false;
  }
}

function browserStorage(): Storage | undefined {
  if (typeof window === "undefined") return undefined;
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}
