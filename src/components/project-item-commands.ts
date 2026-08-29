import type { Composition, Project, ProjectFolder } from "../core/types";
import { createId } from "../core/types";
import type { ProjectContextTarget } from "./ProjectContextMenu";
import { duplicateTimelineLayers } from "./timeline-layer-clipboard";

export type ProjectItemDeleteBlock =
  | "finalComposition"
  | "compositionReferenced"
  | "sourceReferenced"
  | "folderNotEmpty";

export function duplicateProjectComposition(composition: Composition, name: string): Composition {
  const duplicate = structuredClone(composition);
  duplicate.id = createId();
  duplicate.name = name.trim().slice(0, 256) || `${composition.name} Copy`;
  duplicate.layers = duplicateTimelineLayers(composition.layers).map((layer, index) => ({
    ...layer,
    name: composition.layers[index]?.name ?? layer.name,
  }));
  return duplicate;
}

export function projectItemDeleteBlock(
  project: Project,
  target: ProjectContextTarget,
): ProjectItemDeleteBlock | undefined {
  if (target.kind === "empty") return undefined;
  if (target.kind === "composition") {
    if (project.compositions.length <= 1) return "finalComposition";
    if (
      project.compositions.some((composition) =>
        composition.layers.some((layer) => layer.sourceCompositionId === target.id),
      )
    )
      return "compositionReferenced";
    return undefined;
  }
  if (target.kind === "source")
    return project.compositions.some((composition) =>
      composition.layers.some((layer) => layer.sourceId === target.id),
    )
      ? "sourceReferenced"
      : undefined;
  return project.folders.some((folder) => folder.parentId === target.id) ||
    Object.values(project.itemFolderIds).includes(target.id)
    ? "folderNotEmpty"
    : undefined;
}

export function projectFolderMoveDestinations(
  project: Project,
  target: Exclude<ProjectContextTarget, { kind: "empty" }>,
): { includeRoot: boolean; folders: ProjectFolder[] } {
  const currentFolderId =
    target.kind === "folder"
      ? project.folders.find((folder) => folder.id === target.id)?.parentId
      : project.itemFolderIds[target.id];
  const excluded =
    target.kind === "folder" ? folderDescendants(project.folders, target.id) : new Set<string>();
  if (target.kind === "folder") excluded.add(target.id);
  return {
    includeRoot: currentFolderId !== undefined,
    folders: project.folders.filter(
      (folder) => folder.id !== currentFolderId && !excluded.has(folder.id),
    ),
  };
}

function folderDescendants(folders: readonly ProjectFolder[], rootId: string): Set<string> {
  const descendants = new Set<string>();
  const queue = [rootId];
  for (let index = 0; index < queue.length; index += 1) {
    const parentId = queue[index];
    for (const folder of folders) {
      if (folder.parentId !== parentId || descendants.has(folder.id)) continue;
      descendants.add(folder.id);
      queue.push(folder.id);
    }
  }
  return descendants;
}
