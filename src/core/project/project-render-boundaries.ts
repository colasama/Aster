import { assertAdjustmentLayerInvariants } from "../layers/adjustment-layer";
import type { Composition, Layer, Project } from "../types";

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
  for (const [index, layer] of composition.layers.entries()) {
    assertAdjustmentLayerInvariants(layer, composition, `${path}.layers[${index}]`);
    assertLayerEffectLimits(layer, `${path}.layers[${index}]`);
  }
}

export function assertProjectRenderBoundaries(
  project: Pick<Project, "compositions">,
  path = "project",
): void {
  const compositions = new Map(
    project.compositions.map((composition) => [composition.id, composition]),
  );
  const visited = new Set<string>();
  const visiting = new Set<string>();
  const visit = (composition: Composition): void => {
    if (visiting.has(composition.id)) throw new Error("Recursive precomposition reference");
    if (visited.has(composition.id)) return;
    visiting.add(composition.id);
    for (const layer of composition.layers) {
      if (layer.kind !== "precomposition") continue;
      const source = compositions.get(layer.sourceCompositionId ?? "");
      if (!source) throw new Error("Precomposition source does not exist");
      visit(source);
    }
    visiting.delete(composition.id);
    visited.add(composition.id);
  };
  for (const [index, composition] of project.compositions.entries()) {
    assertCompositionRenderBoundaries(composition, `${path}.compositions[${index}]`);
    visit(composition);
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
