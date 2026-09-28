import { cloneTimelineLayers } from "../core/editing/clone-layers";
import type { Operation } from "../core/editing/operations";
import { activeComposition } from "../core/project/project";
import type { Id, Layer, Project } from "../core/types";

/** Selected layers of the active composition, in stacking order. */
export function selectedLayers(project: Project, selection: readonly Id[]): Layer[] {
  const selected = new Set(selection);
  return activeComposition(project).layers.filter((layer) => selected.has(layer.id));
}

/** Removes the selection, or returns nothing when it is empty or contains a locked layer. */
export function removeSelectedLayersOperations(
  project: Project,
  selection: readonly Id[],
): Operation[] | undefined {
  const layers = selectedLayers(project, selection);
  if (layers.length === 0 || layers.some((layer) => layer.locked)) return undefined;
  return layers.map((layer) => ({ type: "removeLayer", layerId: layer.id }));
}

/** Clones the selection with fresh layer, effect and keyframe identities. */
export function duplicateSelectedLayers(
  project: Project,
  selection: readonly Id[],
  rename: (name: string) => string,
): Layer[] {
  return cloneTimelineLayers(selectedLayers(project, selection), true).map((layer) => ({
    ...layer,
    name: rename(layer.name),
  }));
}
