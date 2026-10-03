import { BUILTIN_PARTICLE_PLUGIN_ID } from "../../src/core/scene/bundled-particle";
import type { Layer } from "../../src/core/types";
import { LAYER_STYLE_EFFECTS } from "../../src/effects/definitions/compositing/layer-styles";
import type { GeneratedCase } from "./types";

export function featureHasEvidence(
  feature: string,
  value: GeneratedCase,
  layers: Layer[],
): boolean {
  const { project, case: item } = value;
  const effects = layers.flatMap((layer) => layer.effects.filter((effect) => effect.enabled));
  const drawn = layers.filter((layer) => layer.kind !== "audio" && layer.kind !== "null");
  const sourceIds = new Set(layers.map((layer) => layer.sourceId).filter(Boolean));
  const sources = project.sources.filter((source) => sourceIds.has(source.id));
  const compositions = project.compositions.filter(
    (composition) =>
      composition.id === item.composition ||
      layers.some((layer) => layer.sourceCompositionId === composition.id),
  );
  if (feature.startsWith("shape:"))
    return layers.some((layer) => layer.shape?.kind === feature.slice(6));
  if (feature.startsWith("mask:"))
    return effects.some((effect) => effect.mask?.shape === feature.slice(5));
  if (feature.startsWith("plugin:"))
    return layers.some((layer) => layer.generator?.pluginId === feature.slice(7));
  if (feature.startsWith("psd:"))
    return Boolean(
      project.mediaImports?.entries.some(
        (entry) => entry.kind === "psd" && entry.importMode === feature.slice(4),
      ),
    );
  switch (feature) {
    case "feature:aces":
    case "feature:filmic":
      return effects.some(
        (effect) =>
          effect.type === "filmic-tone-map" &&
          effect.parameters.curve === (feature === "feature:aces" ? 0 : 1),
      );
    case "feature:effect-chain":
      return layers.some((layer) => layer.effects.filter((effect) => effect.enabled).length > 1);
    case "feature:effect-masks":
    case "feature:masks":
      return effects.some((effect) => effect.mask && effect.mask.shape !== "path");
    case "feature:path-mask-schema":
      return layers.some((layer) =>
        layer.effects.some(
          (effect) =>
            effect.enabled &&
            effect.mask?.shape === "path" &&
            layer.shapeGraph?.paths.some((path) => path.id === effect.mask?.pathId),
        ),
      );
    case "feature:mattes":
      return effects.some((effect) => /matte|key/.test(effect.type));
    case "feature:nested-precompositions":
      return layers.some((layer) =>
        compositions
          .find((composition) => composition.id === layer.sourceCompositionId)
          ?.layers.some((child) => child.sourceCompositionId && layers.includes(child)),
      );
    case "feature:precomposition-surfaces":
      return layers.some(
        (layer) => layer.sourceCompositionId && layer.effects.some((effect) => effect.enabled),
      );
    case "feature:backdrop-blends":
      return drawn.length > 1 && layers.some((layer) => layer.blendMode === "soft-light");
    case "feature:parenting":
      return layers.some((layer) => layers.some((parent) => parent.id === layer.parentId));
    case "feature:transforms":
      return layers.some((layer) =>
        layer.transform.rotation.some((value) => value.mode === "animated" || value.value !== 0),
      );
    case "feature:adjustment-layers":
      return (
        layers.some(
          (layer) => layer.kind === "adjustment" && layer.effects.some((effect) => effect.enabled),
        ) && drawn.length >= 2
      );
    case "feature:text-animators":
      return layers.some(
        (layer) =>
          layer.kind === "text" &&
          layer.textAnimator?.enabled &&
          layer.textAnimator.groups.some((group) => group.enabled),
      );
    case "feature:text-multiscript":
      return layers.some(
        (layer) =>
          /[A-Za-z]/.test(layer.text ?? "") &&
          /[\u4e00-\u9fff]/.test(layer.text ?? "") &&
          /[\u0600-\u06ff]/.test(layer.text ?? ""),
      );
    case "feature:camera":
      return (
        layers.some((layer) => layer.camera) &&
        layers.some((layer) => layer.threeDimensional && !layer.camera && !layer.light)
      );
    case "feature:depth-of-field":
      return layers.some((layer) => layer.camera?.depthOfField);
    case "feature:motion-blur":
    case "feature:text-motion-blur":
      return compositions.some(
        (composition) =>
          composition.motionBlur.enabled &&
          composition.layers.some(
            (layer) =>
              layers.includes(layer) &&
              layer.motionBlur &&
              (feature !== "feature:text-motion-blur" || layer.kind === "text"),
          ),
      );
    case "feature:lights":
      return layers.some((layer) => layer.light && layer.light.intensity > 0);
    case "feature:shadows":
      return (
        layers.some(
          (layer) =>
            layer.light && layer.light.kind !== "point" && layer.light.shadowQuality !== "off",
        ) && layers.some((layer) => layer.mesh)
      );
    case "feature:meshes":
      return layers.some(
        (layer) => layer.mesh && layer.mesh.positions.length >= 9 && layer.mesh.indices.length >= 3,
      );
    case "feature:hdr-environment":
      return compositions.some(
        (composition) =>
          composition.environment?.enabled &&
          composition.environment.source.dataUrl.startsWith("data:"),
      );
    case "feature:bundled-particles":
      return layers.some((layer) => layer.generator?.pluginId === BUILTIN_PARTICLE_PLUGIN_ID);
    case "feature:audio-analysis":
      return (
        sources.some((source) => source.kind === "audio") &&
        Boolean(item.plugins?.includes("examples/plugins/audio-spectrum")) &&
        layers.some((layer) => layer.generator?.pluginId === "org.aster.example.audio-spectrum")
      );
    case "feature:cloner":
      return layers.some((layer) => layer.cloner);
    case "feature:layer-styles":
      return effects.some((effect) =>
        LAYER_STYLE_EFFECTS.some((style) => style.type === effect.type),
      );
    case "media:png":
    case "media:jpeg":
    case "media:exr":
      return sources.some(
        (source) => source.kind === "still" && source.mimeType.includes(feature.slice(6)),
      );
    case "media:audio":
      return sources.some((source) => source.kind === "audio");
    case "media:mp4":
      return sources.some((source) => source.kind === "video" && source.mimeType === "video/mp4");
    case "media:frame-identity":
      return sources.some((source) => source.kind === "video" || source.kind === "imageSequence");
    case "media:hold-boundaries":
      return sources.some(
        (source) =>
          source.kind === "imageSequence" &&
          source.interpretation.frameRate &&
          compositions.some(
            (composition) =>
              composition.frameRate.numerator / composition.frameRate.denominator >
              (source.interpretation.frameRate?.numerator ?? 0) /
                (source.interpretation.frameRate?.denominator ?? 1),
          ),
      );
    case "media:svg":
    case "media:psd":
      return (
        sources.some((source) => source.kind === feature.slice(6)) &&
        Boolean(project.mediaImports?.entries.length)
      );
    case "media:image-sequence":
      return (
        sources.some((source) => source.kind === "imageSequence") &&
        Boolean(
          project.mediaImports?.payloads.some(
            (payload) => payload.kind === "imageSequence" && payload.frames.length > 1,
          ),
        )
      );
    case "video:24000/1001":
    case "video:30000/1001": {
      const numerator = Number(feature.slice(6).split("/")[0]);
      return sources.some(
        (source) =>
          source.kind === "video" &&
          source.interpretation.frameRate?.numerator === numerator &&
          source.interpretation.frameRate.denominator === 1001,
      );
    }
    case "video:seek-boundaries":
      return (
        sources.some((source) => source.kind === "video") &&
        item.frames.some((frame, index) => index > 0 && frame < item.frames[index - 1])
      );
    case "lut:trilinear":
    case "lut:tetrahedral":
      return effects.some(
        (effect) =>
          effect.resource?.kind === "lut3d" &&
          effect.parameters.interpolation === (feature === "lut:tetrahedral" ? 1 : 0),
      );
    default:
      return false;
  }
}
