import type { Project } from "../../core/types";

/** Keep every time-reachable dependency, including hidden and currently inactive layers. */
export function previewProjectClosure(project: Project, compositionId: string): Project {
  const compositions = new Map(
    project.compositions.map((composition) => [composition.id, composition]),
  );
  const reachable = new Set<string>();
  const sources = new Set<string>();
  const pending = [compositionId];
  while (pending.length) {
    const id = pending.pop();
    if (!id || reachable.has(id)) continue;
    const composition = compositions.get(id);
    if (!composition) throw new Error("Preview composition dependency is missing");
    reachable.add(id);
    for (const layer of composition.layers) {
      if (layer.sourceCompositionId) pending.push(layer.sourceCompositionId);
      if (layer.sourceId) sources.add(layer.sourceId);
    }
  }
  return {
    ...project,
    activeCompositionId: compositionId,
    compositions: project.compositions.filter((composition) => reachable.has(composition.id)),
    sources: project.sources.filter((source) => sources.has(source.id)),
    itemFolderIds: Object.fromEntries(
      Object.entries(project.itemFolderIds).filter(([id]) => reachable.has(id) || sources.has(id)),
    ),
    commandLog: [],
  };
}
