import type { WorkspaceViewerIdentity } from "../components/workspace/WorkspaceViewerIdentity";
import type { Composition, Project } from "../core/types";

export interface ResolvedWorkspaceViewerComposition {
  readonly composition: Composition;
  readonly readOnly: boolean;
}

export function resolveWorkspaceViewerComposition(
  project: Project,
  identity: WorkspaceViewerIdentity | null,
): ResolvedWorkspaceViewerComposition {
  const active =
    project.compositions.find((composition) => composition.id === project.activeCompositionId) ??
    project.compositions[0];
  if (!active) throw new Error("The project has no composition");
  if (!identity?.locked || !identity.contextId) return { composition: active, readOnly: false };
  const locked = project.compositions.find((composition) => composition.id === identity.contextId);
  if (!locked) return { composition: active, readOnly: false };
  return { composition: locked, readOnly: locked.id !== active.id };
}
