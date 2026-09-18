import { evaluateUnclampedSourceTime } from "../animation/layer-time";
import type { Composition, Layer, Project } from "../types";
import { decibelsToLinear, layerHasAudio } from "./audio-layer";

export interface AudioInstance {
  layer: Layer;
  ancestors: readonly { layer: Layer; duration: number }[];
  leftGain: number;
  rightGain: number;
}

export function audibleLayers(composition: Composition): Layer[] {
  const soloKinds = new Set(
    composition.layers
      .filter((layer) => layer.solo && layerHasAudio(layer))
      .map((layer) => layer.kind),
  );
  return composition.layers.filter(
    (layer) =>
      layerHasAudio(layer) &&
      layer.audioEnabled !== false &&
      !layer.audio?.muted &&
      (!soloKinds.has(layer.kind) || layer.solo),
  );
}

/** Audio traverses references independently of visual visibility and render isolation. */
export function collectAudioInstances(project: Project, composition: Composition): AudioInstance[] {
  const compositions = new Map(project.compositions.map((source) => [source.id, source]));
  const instances: AudioInstance[] = [];
  const visit = (
    source: Composition,
    ancestors: AudioInstance["ancestors"],
    left: number,
    right: number,
    path: Set<string>,
  ): void => {
    if (path.has(source.id)) throw new Error("Recursive audio composition reference");
    const nextPath = new Set(path).add(source.id);
    for (const layer of audibleLayers(source)) {
      const settings = layer.audio;
      const leftGain =
        left *
        decibelsToLinear(settings?.levelsDb[0] ?? 0) *
        Math.sqrt(1 - Math.max(0, settings?.pan ?? 0));
      const rightGain =
        right *
        decibelsToLinear(settings?.levelsDb[1] ?? 0) *
        Math.sqrt(1 + Math.min(0, settings?.pan ?? 0));
      if (layer.kind === "precomposition") {
        const child = compositions.get(layer.sourceCompositionId ?? "");
        if (!child) throw new Error("Audio composition source does not exist");
        visit(
          child,
          [...ancestors, { layer, duration: child.duration }],
          leftGain,
          rightGain,
          nextPath,
        );
      } else instances.push({ layer, ancestors, leftGain, rightGain });
    }
  };
  visit(composition, [], 1, 1, new Set());
  return instances;
}

export function audioInstanceTime(instance: AudioInstance, time: number): number | undefined {
  for (const ancestor of instance.ancestors) {
    if (time < ancestor.layer.inPoint || time >= ancestor.layer.outPoint) return undefined;
    time = evaluateUnclampedSourceTime(ancestor.layer, time);
    if (ancestor.layer.audio?.reversed) time = ancestor.duration - time;
    if (time < 0 || time >= ancestor.duration) return undefined;
  }
  return time;
}
