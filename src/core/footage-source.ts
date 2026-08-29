import type { FootageSource, Id, Layer, Project, SourceInterpretation } from "./types";

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
  if (layer.kind === "image") return source.kind === "still";
  if (layer.kind === "video") return source.kind === "video";
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

export function sourceContentIdentity(value: {
  mimeType: string;
  dataUrl?: string;
  relativePath?: string;
  runtimeUrl?: string;
  width?: number;
  height?: number;
  duration?: number;
}): string {
  const locator = value.dataUrl ?? value.relativePath ?? value.runtimeUrl ?? "missing";
  let left = 0x811c9dc5;
  let right = 0x9e3779b9;
  let length = 0;
  for (const part of [
    value.mimeType,
    locator,
    String(value.width ?? 0),
    String(value.height ?? 0),
    String(value.duration ?? 0),
  ]) {
    for (let index = 0; index <= part.length; index += 1) {
      const code = index === part.length ? 0 : part.charCodeAt(index);
      left = Math.imul(left ^ code, 0x01000193);
      right = Math.imul(right ^ code, 0x85ebca6b);
      length += 1;
    }
  }
  return `fnv64:${(left >>> 0).toString(16).padStart(8, "0")}${(right >>> 0)
    .toString(16)
    .padStart(8, "0")}:${length}`;
}

export function copySourceWithoutRuntimeUrl(source: FootageSource): FootageSource {
  const { runtimeUrl: _runtimeUrl, ...persisted } = source;
  return {
    ...persisted,
    interpretation: { ...persisted.interpretation },
  } as FootageSource;
}
