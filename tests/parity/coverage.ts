import { evaluateLayerSourceTime } from "../../src/core/animation/layer-time";
import {
  audibleCompositionLayers,
  evaluateLayerAudioSourceTime,
} from "../../src/core/audio/audio-mixer";
import { validateProjectDocument } from "../../src/core/project/validation/document";
import { ANTI_ALIASING_MODES } from "../../src/core/rendering/anti-aliasing";
import { visibleLayersAtTime } from "../../src/core/scene/scene-evaluation";
import { BLEND_MODES, LAYER_KINDS, type Layer } from "../../src/core/types";
import { EFFECT_REGISTRY } from "../../src/effects/registry";
import { validatePersistedMediaImports } from "../../src/importers/media-import-persistence-codec";
import { featureHasEvidence } from "./feature-evidence";
import type { GeneratedCase } from "./types";

export const REQUIRED_FEATURES = [
  "feature:masks",
  "feature:mattes",
  "feature:nested-precompositions",
  "feature:adjustment-layers",
  "feature:text-animators",
  "feature:camera",
  "feature:depth-of-field",
  "feature:motion-blur",
  "feature:lights",
  "feature:shadows",
  "feature:meshes",
  "feature:hdr-environment",
  "feature:bundled-particles",
  "feature:audio-analysis",
  "feature:cloner",
  "feature:layer-styles",
  "media:png",
  "media:jpeg",
  "media:svg",
  "media:psd",
  "media:image-sequence",
  "video:24000/1001",
  "video:30000/1001",
  "video:seek-boundaries",
  "lut:trilinear",
  "lut:tetrahedral",
] as const;

export function caseLayers(value: GeneratedCase): Layer[] {
  const visited = new Map<string, Set<number>>();
  const layers = new Set<Layer>();
  const visit = (id: string, time: number, ancestry: Set<string>) => {
    if (ancestry.has(id) || visited.get(id)?.has(time)) return;
    const times = visited.get(id) ?? new Set<number>();
    times.add(time);
    visited.set(id, times);
    const composition = value.project.compositions.find((item) => item.id === id);
    if (!composition) throw new Error(`${value.case.id}: missing composition ${id}`);
    const nextAncestry = new Set(ancestry).add(id);
    for (const layer of visibleLayersAtTime(composition, time)) {
      layers.add(layer);
      if (layer.kind !== "precomposition" || !layer.sourceCompositionId) continue;
      const source = value.project.compositions.find(
        (item) => item.id === layer.sourceCompositionId,
      );
      if (!source)
        throw new Error(`${value.case.id}: missing composition ${layer.sourceCompositionId}`);
      visit(source.id, evaluateLayerSourceTime(layer, time, source.duration), nextAncestry);
    }
    for (const layer of audibleCompositionLayers(composition)) {
      if (layer.kind !== "audio") continue;
      const source = value.project.sources.find((item) => item.id === layer.sourceId);
      if (
        source?.kind === "audio" &&
        evaluateLayerAudioSourceTime(layer, time, source.duration) !== undefined
      ) {
        layers.add(layer);
      }
    }
  };
  const root = value.project.compositions.find((item) => item.id === value.case.composition);
  if (!root) throw new Error(`${value.case.id}: missing composition ${value.case.composition}`);
  for (const frame of value.case.frames) {
    const time = (frame * root.frameRate.denominator) / root.frameRate.numerator;
    visit(root.id, time, new Set());
  }
  return [...layers];
}

export function assertCaseStructure(value: GeneratedCase): void {
  const { case: item, project } = value;
  validateProjectDocument(project);
  if (project.mediaImports) validatePersistedMediaImports(project.mediaImports);
  const composition = project.compositions.find((entry) => entry.id === item.composition);
  if (!composition) throw new Error(`${item.id}: no addressed composition`);
  const maxFrame = Math.ceil(
    (composition.duration * composition.frameRate.numerator) / composition.frameRate.denominator,
  );
  if (
    !item.frames.length ||
    new Set(item.frames).size !== item.frames.length ||
    item.frames.some((frame) => !Number.isInteger(frame) || frame < 0 || frame >= maxFrame)
  )
    throw new Error(`${item.id}: invalid or duplicate frame addresses`);
  if (item.size.width < 1 || item.size.height < 1 || !ANTI_ALIASING_MODES.includes(item.aa))
    throw new Error(`${item.id}: invalid target size or AA`);
  const layers = caseLayers(value);
  for (const feature of item.features) {
    const [kind, name] = feature.split(":", 2);
    let valid = featureHasEvidence(feature, value, layers);
    if (kind === "layer") valid = layers.some((layer) => layer.kind === name);
    if (kind === "blend") valid = layers.some((layer) => layer.blendMode === name);
    if (kind === "aa") valid = item.aa === name;
    if (kind === "effect")
      valid = layers.some((layer) =>
        layer.effects.some((effect) => effect.enabled && effect.type === name),
      );
    if (!valid) throw new Error(`${item.id}: feature ${feature} has no active scene object`);
  }
}

export function assertCorpusCoverage(values: GeneratedCase[]): void {
  const ids = values.map((value) => value.case.id);
  if (new Set(ids).size !== ids.length) throw new Error("Corpus contains duplicate case ids");
  for (const value of values) assertCaseStructure(value);
  const required = [
    ...LAYER_KINDS.map((kind) => `layer:${kind}`),
    ...BLEND_MODES.map((mode) => `blend:${mode}`),
    ...ANTI_ALIASING_MODES.map((mode) => `aa:${mode}`),
    ...EFFECT_REGISTRY.map((effect) => `effect:${effect.type}`),
    ...REQUIRED_FEATURES,
  ];
  const present = new Set(values.flatMap((value) => value.case.features));
  const missing = required.filter((feature) => !present.has(feature));
  if (missing.length) throw new Error(`Corpus coverage missing: ${missing.join(", ")}`);
}
