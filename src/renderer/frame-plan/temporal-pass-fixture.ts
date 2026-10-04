import { buildTemporalTextPassPlan } from "../text/text-motion-blur-pass-plan";
import { decodeFramePlan, encodeFramePlan } from "./codec";
import { productionUniformFixtures } from "./fixture";
import { buildTemporalPassSlice } from "./temporal-pass-plan";

export function temporalPassFixtures() {
  const header = decodeFramePlan(productionUniformFixtures()[0].bytes).metadata.header;
  return [
    { id: "full", weights: [0.25, 0.25, 0.5] },
    { id: "partial", weights: [0.125, 0.375] },
    { id: "transparent", weights: [] },
    { id: "exact-bits", weights: [-0, Number.MIN_VALUE, 1 / 3] },
  ].map(({ id, weights }) => {
    const hashes = ["a", "b", "c", "d"].map((c) => c.repeat(64));
    const passes = buildTemporalTextPassPlan(64, 32, weights, {
      hashFor: (id) => hashes[id === "output" ? 0 : Number(id.split(":")[1]) + 1],
    });
    const slice = buildTemporalPassSlice(header, passes);
    weights.length = 0;
    return {
      id: `temporal-pass-${id}`,
      bytes: encodeFramePlan(slice.metadata, slice.blobs),
      passes,
    };
  });
}
