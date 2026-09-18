import { createLayerForComposition } from "../layers/layer-factory";
import { type Composition, type Layer, type Project, setLayerSizeAndCenterAnchor } from "../types";
import { assertCanAddLayer } from "./project-render-boundaries";

export const COMPOSITION_DRAG_TYPE = "application/x-aster-composition";

export function createCompositionReference(
  project: Project,
  destination: Composition,
  sourceId: string,
  time: number,
): Layer {
  const source = project.compositions.find((composition) => composition.id === sourceId);
  if (!source) throw new Error("Precomposition source does not exist");
  const frame = destination.frameRate.denominator / destination.frameRate.numerator;
  const start = Math.min(
    Math.max(0, Math.round(time / frame) * frame),
    destination.duration - frame,
  );
  const layer = createLayerForComposition("precomposition", destination, start);
  layer.name = source.name;
  layer.sourceCompositionId = source.id;
  layer.timeOffset = 0;
  layer.outPoint = Math.min(destination.duration, start + source.duration);
  setLayerSizeAndCenterAnchor(layer, [source.width, source.height]);
  assertCanAddLayer(project, destination, layer);
  return layer;
}
