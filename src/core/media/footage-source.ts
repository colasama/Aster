import type { FootageSource, Id, Layer, Project, SourceInterpretation } from "../types";

export const MAX_SOURCE_DIMENSION = 30_000;
export const MAX_SOURCE_DURATION = 86_400;
export const MAX_SOURCE_NAME_LENGTH = 512;
export const DEFAULT_SOURCE_INTERPRETATION: SourceInterpretation = {
  alpha: "straight",
  colorSpace: "srgb",
};

export function sourceForLayer(
  project: Project | undefined,
  layer: Layer,
): FootageSource | undefined {
  if (!project || !layer.sourceId) return undefined;
  return project.sources.find((source) => source.id === layer.sourceId);
}

export function sourceSupportsLayer(source: FootageSource, layer: Layer): boolean {
  if (layer.kind === "image")
    return (
      source.kind === "still" ||
      source.kind === "imageSequence" ||
      source.kind === "svg" ||
      source.kind === "psd"
    );
  if (layer.kind === "video") return source.kind === "video";
  if (layer.kind === "audio")
    return source.kind === "audio" || (source.kind === "video" && source.audio !== undefined);
  return false;
}

export function referencedSourceIds(project: Project): Set<Id> {
  return new Set(
    project.compositions.flatMap((composition) =>
      composition.layers.flatMap((layer) => (layer.sourceId ? [layer.sourceId] : [])),
    ),
  );
}

export function sourceLocator(source: FootageSource | undefined): string | undefined {
  return source?.dataUrl ?? source?.runtimeUrl;
}

export { sourceContentIdentity } from "./source-content-identity.js";

export function copySourceWithoutRuntimeUrl(source: FootageSource): FootageSource {
  const { runtimeUrl: _runtimeUrl, ...persisted } = source;
  return {
    ...persisted,
    interpretation: { ...persisted.interpretation },
    ...(persisted.kind === "video" && persisted.audio ? { audio: { ...persisted.audio } } : {}),
  } as FootageSource;
}
