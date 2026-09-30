import { activeComposition } from "../core/project/project";
import { type CameraFitOptions, fitLayerToCamera } from "../core/scene/camera-fit";
import type { Composition, Project } from "../core/types";
import type { AiCommandBatch } from "./command-normalizer";

/** Runs commands against a composition, restoring the previously active one afterwards. */
function inComposition<T>(batch: AiCommandBatch, compositionId: string, run: () => T): T {
  const previous = batch.project.activeCompositionId;
  if (previous !== compositionId) batch.append({ type: "setActiveComposition", compositionId });
  try {
    return run();
  } finally {
    if (batch.project.activeCompositionId !== previous)
      batch.append({ type: "setActiveComposition", compositionId: previous });
  }
}

function requireComposition(project: Project, id: unknown): Composition {
  const composition =
    typeof id === "string"
      ? project.compositions.find((candidate) => candidate.id === id)
      : activeComposition(project);
  if (!composition) throw new Error(`Unknown composition: ${String(id)}`);
  return composition;
}

/** Computes, and optionally applies, the camera-fit scale multiplier for a 3D layer. */
export function fitScriptLayer(batch: AiCommandBatch, input: Record<string, unknown>) {
  const composition = requireComposition(batch.project, input.compositionId);
  const layer = composition.layers.find((candidate) => candidate.id === input.layerId);
  if (!layer)
    throw new Error(
      `Unknown layer ${String(input.layerId)} in composition "${composition.name}" (${composition.id})`,
    );
  const options = (input.options ?? {}) as CameraFitOptions & { apply?: boolean };
  const fit = fitLayerToCamera(composition, layer, options);
  if (options.apply === false) return { ...fit, applied: false };
  inComposition(batch, composition.id, () => {
    for (const path of ["scale.0", "scale.1"] as const) {
      const property = layer.transform.scale[path === "scale.0" ? 0 : 1];
      if (property.mode === "static")
        batch.append({
          type: "setProperty",
          layerId: layer.id,
          path,
          value: property.value * fit.scaleMultiplier,
        });
      else
        for (const keyframe of property.keyframes)
          batch.append({
            type: "updateKeyframe",
            layerId: layer.id,
            path,
            keyframeId: keyframe.id,
            time: keyframe.time,
            value: keyframe.value * fit.scaleMultiplier,
            interpolation: keyframe.interpolation,
            ...(keyframe.easing ? { easing: keyframe.easing } : {}),
          });
    }
  });
  return { ...fit, applied: true };
}

/**
 * Removes compositions in dependency order: a composition goes once no remaining composition
 * nests it, so orphaned parent/child chains are removed in one call.
 */
export function removeScriptCompositions(batch: AiCommandBatch, ids: readonly string[]) {
  const pending = new Set(ids);
  for (const id of pending)
    if (!batch.project.compositions.some((composition) => composition.id === id))
      throw new Error(`Unknown composition: ${id}`);
  const removed: Array<{ id: string; name: string }> = [];
  while (pending.size > 0) {
    const removable = [...pending].filter(
      (id) =>
        id !== batch.project.activeCompositionId &&
        !batch.project.compositions.some(
          (composition) =>
            composition.id !== id &&
            composition.layers.some((layer) => layer.sourceCompositionId === id),
        ),
    );
    if (removable.length === 0) {
      const blocked = [...pending].map((id) => {
        const composition = batch.project.compositions.find((candidate) => candidate.id === id);
        return `${composition?.name ?? id} (${id})`;
      });
      throw new Error(
        `Cannot remove compositions that are active or still nested elsewhere: ${blocked.join(", ")}`,
      );
    }
    for (const id of removable) {
      const composition = batch.project.compositions.find((candidate) => candidate.id === id);
      batch.append({ type: "removeComposition", compositionId: id });
      removed.push({ id, name: composition?.name ?? id });
      pending.delete(id);
    }
  }
  return removed;
}

/**
 * Removes every composition that cannot be reached from the roots (the active composition plus
 * `keep`, matched by id or exact name) through precomposition layers.
 */
export function collectUnusedCompositions(batch: AiCommandBatch, input: Record<string, unknown>) {
  const project = batch.project;
  const keep = Array.isArray(input.keep) ? input.keep.map(String) : [];
  const roots = new Set<string>([project.activeCompositionId]);
  for (const composition of project.compositions)
    if (keep.includes(composition.id) || keep.includes(composition.name)) roots.add(composition.id);
  const reachable = new Set<string>();
  const visit = (id: string) => {
    if (reachable.has(id)) return;
    reachable.add(id);
    const composition = project.compositions.find((candidate) => candidate.id === id);
    for (const layer of composition?.layers ?? [])
      if (layer.sourceCompositionId) visit(layer.sourceCompositionId);
  };
  for (const root of roots) visit(root);
  const unused = project.compositions
    .filter((composition) => !reachable.has(composition.id))
    .map((composition) => ({ id: composition.id, name: composition.name }));
  if (input.dryRun === true)
    return { dryRun: true, unused, kept: reachable.size, sourcesRemoved: 0 };
  removeScriptCompositions(
    batch,
    unused.map((composition) => composition.id),
  );
  let sourcesRemoved = 0;
  if (input.sources === true) {
    const before = batch.project.sources.length;
    batch.append({ type: "cleanupOrphanSources" });
    sourcesRemoved = before - batch.project.sources.length;
  }
  return { removed: unused, kept: reachable.size, sourcesRemoved };
}
