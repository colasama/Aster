import { assertAdjustmentLayerInvariants } from "./adjustment-layer";
import type { Composition, Layer, Project } from "./types";

export const NESTED_ADJUSTMENT_ERROR =
  "Precomposition sources cannot contain adjustment layers in the flat MVP renderer";
export const PARTICLE_LAYER_LIMIT_ERROR =
  "A composition can contain at most one GPU particle layer in the MVP renderer";
export const NESTED_PARTICLE_ERROR =
  "Precomposition sources cannot contain GPU particle layers in the MVP renderer";
export const PARTICLE_CLONER_ERROR =
  "GPU particle layers cannot use cloners in the single-simulation MVP renderer";
export const ENABLED_LUT_LIMIT_ERROR = "A layer can contain at most one enabled 3D LUT effect";

export function assertLayerEffectLimits(layer: Pick<Layer, "effects">, path = "layer"): void {
  const enabledLutCount = layer.effects.filter(
    (effect) => effect.enabled && effect.type === "lut",
  ).length;
  if (enabledLutCount > 1) throw new Error(`${path}: ${ENABLED_LUT_LIMIT_ERROR}`);
}

export function assertCompositionRenderBoundaries(
  composition: Pick<Composition, "layers" | "width" | "height">,
  path = "composition",
): void {
  if (composition.layers.filter((layer) => layer.kind === "particle").length > 1)
    throw new Error(`${path}: ${PARTICLE_LAYER_LIMIT_ERROR}`);
  for (const [index, layer] of composition.layers.entries()) {
    if (layer.kind === "particle" && layer.cloner !== undefined)
      throw new Error(`${path}.layers[${index}]: ${PARTICLE_CLONER_ERROR}`);
    assertAdjustmentLayerInvariants(layer, composition, `${path}.layers[${index}]`);
    assertLayerEffectLimits(layer, `${path}.layers[${index}]`);
  }
}

export function assertProjectRenderBoundaries(
  project: Pick<Project, "compositions">,
  path = "project",
): void {
  const compositions = new Map(
    project.compositions.map((composition) => [composition.id, composition] as const),
  );
  for (const [index, composition] of project.compositions.entries()) {
    assertCompositionRenderBoundaries(composition, `${path}.compositions[${index}]`);
    for (const layer of composition.layers) {
      if (layer.kind !== "precomposition" || !layer.sourceCompositionId) continue;
      const source = compositions.get(layer.sourceCompositionId);
      if (source?.layers.some((candidate) => candidate.kind === "adjustment"))
        throw new Error(NESTED_ADJUSTMENT_ERROR);
      if (source && compositionRenderTreeContainsParticle(source, compositions, new Set()))
        throw new Error(NESTED_PARTICLE_ERROR);
    }
  }
}

export function assertCanAddLayer(
  project: Pick<Project, "compositions">,
  composition: Composition,
  layer: Layer,
): void {
  assertProjectWithLayers(project, composition, [layer, ...composition.layers]);
}

export function assertCanUpdateLayer(
  project: Pick<Project, "compositions">,
  composition: Composition,
  layer: Layer,
): void {
  assertProjectWithLayers(
    project,
    composition,
    composition.layers.map((candidate) => (candidate.id === layer.id ? layer : candidate)),
  );
}

function assertProjectWithLayers(
  project: Pick<Project, "compositions">,
  composition: Composition,
  layers: Layer[],
): void {
  const updatedComposition = { ...composition, layers };
  assertProjectRenderBoundaries({
    compositions: project.compositions.map((candidate) =>
      candidate.id === composition.id ? updatedComposition : candidate,
    ),
  });
}

function compositionRenderTreeContainsParticle(
  composition: Composition,
  compositions: ReadonlyMap<string, Composition>,
  visiting: Set<string>,
): boolean {
  if (composition.layers.some((layer) => layer.kind === "particle")) return true;
  if (visiting.has(composition.id)) return false;
  const nextVisiting = new Set(visiting).add(composition.id);
  return composition.layers.some((layer) => {
    if (layer.kind !== "precomposition" || !layer.sourceCompositionId) return false;
    const source = compositions.get(layer.sourceCompositionId);
    return source
      ? compositionRenderTreeContainsParticle(source, compositions, nextVisiting)
      : false;
  });
}
