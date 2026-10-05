import { createLayerForComposition } from "../../../src/core/layers/layer-factory";
import type { Composition, Project } from "../../../src/core/types";
import { auditTemporalFrameReplay } from "./whole-frame";

/** Force two isolated surfaces to consume the same frame-owned temporal derivation. */
export async function auditRecursiveTemporalFrame(project: Project, composition: Composition) {
  const owned = structuredClone(project);
  const source = owned.compositions.find((item) => item.id === composition.id);
  if (!source) throw Error("Temporal source composition is absent");
  let child: Composition = source;
  for (let depth = 0; depth < 2; depth++) {
    const parent: Composition = structuredClone(child);
    parent.id = crypto.randomUUID();
    parent.name = `Temporal parent ${depth}`;
    parent.background = [0, 0, 0, 0];
    const wrapper = createLayerForComposition("precomposition", parent);
    wrapper.sourceCompositionId = child.id;
    wrapper.threeDimensional = true;
    parent.layers = [wrapper];
    owned.compositions.push(parent);
    child = parent;
  }
  return auditTemporalFrameReplay(owned, child, 2);
}
