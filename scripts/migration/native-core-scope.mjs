import assert from "node:assert/strict";

export const coreAdditionalGeometryCases = ["minimal-golden", "layer-null", "scene-cloners"];

export const coreGeometryCases = [
  "layer-solid",
  ...coreAdditionalGeometryCases,
  "shape-bezier",
  "shape-ellipse",
  "shape-line",
  "shape-rectangle",
  "aa-off",
  "aa-fxaa",
  "aa-ssaa2x",
  "aa-ssaa4x",
  "blend-normal",
  "blend-add",
  "blend-multiply",
  "blend-screen",
  "blend-overlay",
  "blend-darken",
  "blend-lighten",
  "blend-color-burn",
  "blend-color-dodge",
  "blend-soft-light",
  "blend-hard-light",
  "blend-difference",
  "blend-exclusion",
];

export const coreLayerCases = [
  "scene-masks-mattes-0",
  "scene-masks-mattes-3",
  "scene-masks-mattes-4",
  "layer-adjustment",
  "scene-path-mask-reference",
  "effect-mask-ellipse",
  "effect-mask-rectangle",
];

export const coreSurfaceCases = ["nested-precompositions", "scene-nested-adjustment"];

export const coreImageCases = ["media-png", "media-jpg"];

export const coreCases = [
  ...coreGeometryCases,
  ...coreImageCases,
  ...coreLayerCases,
  ...coreSurfaceCases,
];

/** Scope is M3 supplied geometry/composition, not native evaluation or the whole effect catalog. */
export function coreCorpus(corpus) {
  const cases = coreCases.map((id) => {
    const item = corpus.cases.find((value) => value.id === id);
    assert(item, `Missing M3 core case: ${id}`);
    return item;
  });
  assert.equal(new Set(coreCases).size, coreCases.length);
  for (const item of corpus.cases) {
    if (item.features.some((feature) => /^(blend:|aa:|shape:|mask:)/.test(feature)))
      assert(coreCases.includes(item.id), `Uncovered core feature case: ${item.id}`);
  }
  return { ...corpus, cases };
}
