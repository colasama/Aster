import { createLayerForComposition } from "./layer-factory";
import { activeComposition, createBlankComposition } from "./project";
import type { Animatable, Id, Layer, Project } from "./types";

export interface PrecompositionResult {
  project: Project;
  wrapperId: Id;
  nestedCompositionId: Id;
}

export function precomposeLayers(
  project: Project,
  selectedIds: Id[],
): PrecompositionResult | undefined {
  const next = structuredClone(project);
  const source = activeComposition(next);
  const selectedSet = new Set(selectedIds);
  const selected = source.layers.filter((layer) => selectedSet.has(layer.id));
  if (selected.length === 0) return undefined;

  const start = Math.min(...selected.map((layer) => layer.inPoint));
  const end = Math.max(...selected.map((layer) => layer.outPoint));
  const frameDuration = source.frameRate.denominator / source.frameRate.numerator;
  const nested = createBlankComposition(
    selected.length === 1 ? `${selected[0].name} Precomp` : `Precomp ${next.compositions.length}`,
  );
  nested.width = source.width;
  nested.height = source.height;
  nested.frameRate = structuredClone(source.frameRate);
  nested.duration = Math.max(frameDuration, end - start);
  nested.background = [0, 0, 0, 0];
  nested.layers = selected.map((layer) => rebaseLayer(layer, start, selectedSet));

  const insertionIndex = Math.min(
    ...selected.map((layer) => source.layers.findIndex((candidate) => candidate.id === layer.id)),
  );
  source.layers = source.layers.filter((layer) => !selectedSet.has(layer.id));
  const wrapper = createLayerForComposition("precomposition", source, start);
  wrapper.name = nested.name;
  wrapper.sourceCompositionId = nested.id;
  wrapper.size = [source.width, source.height];
  wrapper.inPoint = start;
  wrapper.outPoint = end;
  wrapper.color = [0.12, 0.2, 0.42, 0.72];
  source.layers.splice(insertionIndex, 0, wrapper);
  next.compositions.push(nested);
  next.updatedAt = new Date().toISOString();
  return { project: next, wrapperId: wrapper.id, nestedCompositionId: nested.id };
}

function rebaseLayer(layer: Layer, offset: number, selectedIds: Set<Id>): Layer {
  const rebased = structuredClone(layer);
  rebased.inPoint = Math.max(0, rebased.inPoint - offset);
  rebased.outPoint = Math.max(rebased.inPoint, rebased.outPoint - offset);
  if (rebased.parentId && !selectedIds.has(rebased.parentId)) rebased.parentId = undefined;
  for (const property of [
    ...rebased.transform.position,
    ...rebased.transform.rotation,
    ...rebased.transform.scale,
    ...rebased.transform.anchor,
    rebased.transform.opacity,
  ])
    rebaseAnimatable(property, offset);
  return rebased;
}

function rebaseAnimatable(property: Animatable, offset: number): void {
  if (property.mode !== "animated") return;
  for (const keyframe of property.keyframes) keyframe.time = Math.max(0, keyframe.time - offset);
}
