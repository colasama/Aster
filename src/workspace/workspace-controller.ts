import { useSyncExternalStore } from "react";
import type { NamedWorkspace, WorkspaceCatalog } from "./named-workspaces";

export interface WorkspacePanelSummary {
  readonly id: string;
  readonly label: string;
  readonly visible: boolean;
  readonly active?: boolean;
}

export interface WorkspaceController {
  readonly canUndo: boolean;
  readonly catalog: WorkspaceCatalog;
  readonly currentWorkspace: NamedWorkspace;
  readonly panels: readonly WorkspacePanelSummary[];
  deleteWorkspace(workspaceId: string): void;
  renameCurrentWorkspace(name: string): void;
  resetToSavedLayout(): void;
  saveAs(name: string): void;
  select(workspaceId: string): void;
  setPanelVisible(panelId: string, visible: boolean): void;
  undoLayoutChange(): void;
}

let controller: WorkspaceController | null = null;
const listeners = new Set<() => void>();

export function registerWorkspaceController(value: WorkspaceController): () => void {
  controller = value;
  emitChange();
  return () => {
    if (controller !== value) return;
    controller = null;
    emitChange();
  };
}

export function useWorkspaceController(): WorkspaceController | null {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot(): WorkspaceController | null {
  return controller;
}

function getServerSnapshot(): null {
  return null;
}

function emitChange(): void {
  for (const listener of listeners) listener();
}
