import { createLayerForComposition } from "./layer-factory";
import { activeComposition, createBlankComposition } from "./project";
import {
  assertCompositionRenderBoundaries,
  assertProjectRenderBoundaries,
  NESTED_ADJUSTMENT_ERROR,
  NESTED_PARTICLE_ERROR,
} from "./project-render-boundaries";
import type { Animatable, Composition, Id, Layer, Project } from "./types";

export interface PrecompositionPlan {
  selectedIds: Id[];
  insertionIndex: number;
  nestedComposition: Composition;
  wrapper: Layer;
}

export interface PrecompositionResult {
  project: Project;
  wrapperId: Id;
  nestedCompositionId: Id;
}

export function precomposeLayers(
  project: Project,
  selectedIds: Id[],
): PrecompositionResult | undefined {
  const plan = planPrecomposition(project, selectedIds);
  if (!plan) return undefined;
  const next = structuredClone(project);
  applyPrecompositionPlan(next, plan);
  next.updatedAt = new Date().toISOString();
  return {
    project: next,
    wrapperId: plan.wrapper.id,
    nestedCompositionId: plan.nestedComposition.id,
  };
}

export function planPrecomposition(
  project: Project,
  selectedIds: Id[],
): PrecompositionPlan | undefined {
  const source = activeComposition(project);
  const selectedSet = new Set(selectedIds);
  const selected = source.layers.filter((layer) => selectedSet.has(layer.id));
  if (selected.length === 0) return undefined;
  if (selected.some((layer) => layer.kind === "particle")) return undefined;

  const start = Math.min(...selected.map((layer) => layer.inPoint));
  const end = Math.max(...selected.map((layer) => layer.outPoint));
  const frameDuration = source.frameRate.denominator / source.frameRate.numerator;
  const nested = createBlankComposition(
    selected.length === 1
      ? `${selected[0].name} Precomp`
      : `Precomp ${project.compositions.length}`,
  );
  nested.width = source.width;
  nested.height = source.height;
  nested.frameRate = structuredClone(source.frameRate);
  nested.duration = Math.max(frameDuration, end - start);
  nested.workArea = { start: 0, end: nested.duration };
  nested.background = [0, 0, 0, 0];
  nested.layers = selected.map((layer) => rebaseLayer(layer, start, selectedSet));

  const insertionIndex = Math.min(
    ...selected.map((layer) => source.layers.findIndex((candidate) => candidate.id === layer.id)),
  );
  const wrapper = createLayerForComposition("precomposition", source, start);
  wrapper.name = nested.name;
  wrapper.sourceCompositionId = nested.id;
  wrapper.threeDimensional = selected.some((layer) => layer.kind === "adjustment");
  wrapper.size = [source.width, source.height];
  wrapper.inPoint = start;
  wrapper.outPoint = end;
  // The wrapper modulates the sampled surface, so generated precompositions
  // must start as a visually neutral pass-through.
  wrapper.color = [1, 1, 1, 1];
  return {
    selectedIds: selected.map((layer) => layer.id),
    insertionIndex,
    nestedComposition: nested,
    wrapper,
  };
}

export function applyPrecompositionPlan(project: Project, plan: PrecompositionPlan): void {
  if (project.compositions.some((composition) => composition.id === plan.nestedComposition.id))
    throw new Error("Precomposition already exists");
  assertCompositionRenderBoundaries(plan.nestedComposition, "nestedComposition");
  if (
    plan.nestedComposition.layers.some((layer) => layer.kind === "adjustment") &&
    !plan.wrapper.threeDimensional
  )
    throw new Error(NESTED_ADJUSTMENT_ERROR);
  if (plan.nestedComposition.layers.some((layer) => layer.kind === "particle"))
    throw new Error(NESTED_PARTICLE_ERROR);
  const source = activeComposition(project);
  const selected = new Set(plan.selectedIds);
  if (
    selected.size === 0 ||
    ![...selected].every((id) => source.layers.some((layer) => layer.id === id))
  )
    throw new Error("Precomposition source layer does not exist");
  if (source.layers.some((layer) => selected.has(layer.id) && layer.kind === "particle"))
    throw new Error(NESTED_PARTICLE_ERROR);
  if (plan.wrapper.sourceCompositionId) {
    const target =
      plan.wrapper.sourceCompositionId === plan.nestedComposition.id
        ? plan.nestedComposition
        : project.compositions.find(
            (composition) => composition.id === plan.wrapper.sourceCompositionId,
          );
    if (
      target?.layers.some((layer) => layer.kind === "adjustment") &&
      !plan.wrapper.threeDimensional
    )
      throw new Error(NESTED_ADJUSTMENT_ERROR);
  }
  if (source.layers.some((layer) => layer.id === plan.wrapper.id))
    throw new Error("Precomposition wrapper already exists");
  const nextSourceLayers = source.layers.filter((layer) => !selected.has(layer.id));
  nextSourceLayers.splice(
    Math.max(0, Math.min(source.layers.length, plan.insertionIndex)),
    0,
    structuredClone(plan.wrapper),
  );
  const nextSource = { ...source, layers: nextSourceLayers };
  assertProjectRenderBoundaries({
    compositions: [
      ...project.compositions.map((composition) =>
        composition.id === source.id ? nextSource : composition,
      ),
      plan.nestedComposition,
    ],
  });
  source.layers = nextSourceLayers;
  project.compositions.push(structuredClone(plan.nestedComposition));
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
