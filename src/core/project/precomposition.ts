import { createLayerForComposition } from "../layers/layer-factory";
import {
  type Composition,
  type Id,
  type Layer,
  type Project,
  setLayerSizeAndCenterAnchor,
} from "../types";
import { activeComposition, createBlankComposition } from "./project";
import {
  assertCompositionRenderBoundaries,
  assertProjectRenderBoundaries,
} from "./project-render-boundaries";

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
  // Preserve the source clock for every evaluator, including implicit procedural
  // time. The work area isolates the shot without rewriting or clipping tracks.
  nested.duration = Math.max(frameDuration, end);
  nested.workArea = { start, end: nested.duration };
  nested.background = [0, 0, 0, 0];
  nested.environment = structuredClone(source.environment);
  nested.motionBlur = structuredClone(source.motionBlur);
  nested.layers = selected.map((layer) => copyLayerIntoComposition(layer, selectedSet));

  const insertionIndex = Math.min(
    ...selected.map((layer) => source.layers.findIndex((candidate) => candidate.id === layer.id)),
  );
  const wrapper = createLayerForComposition("precomposition", source, start);
  wrapper.name = nested.name;
  wrapper.sourceCompositionId = nested.id;
  wrapper.collapseTransformations = false;
  setLayerSizeAndCenterAnchor(wrapper, [source.width, source.height]);
  wrapper.inPoint = start;
  wrapper.outPoint = end;
  wrapper.timeOffset = start;
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
  const source = activeComposition(project);
  const selected = new Set(plan.selectedIds);
  if (
    selected.size === 0 ||
    ![...selected].every((id) => source.layers.some((layer) => layer.id === id))
  )
    throw new Error("Precomposition source layer does not exist");
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

function copyLayerIntoComposition(layer: Layer, selectedIds: Set<Id>): Layer {
  const copied = structuredClone(layer);
  if (copied.parentId && !selectedIds.has(copied.parentId)) copied.parentId = undefined;
  return copied;
}
