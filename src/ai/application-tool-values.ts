import {
  MAX_AI_CONTEXT_BYTES,
  queryAssets,
  queryEffects,
  queryProperties,
  queryScene,
  queryTimeline,
} from "../core/editing/ai-context";
import type { Operation } from "../core/editing/operations";
import { activeComposition } from "../core/project/project";
import { projectFontMetadata } from "../core/project/project-fonts";
import type { Composition, Project } from "../core/types";
import { encodedBytes } from "./edit-limits";
import type { AgentRenderedPreviewFrame } from "./render-preview";

const MAX_QUERY_BYTES = 64 * 1024;
const MAX_RENDER_SAMPLES = 12;

export interface ProjectQuery {
  kind: string;
  selection: string[];
  time: number;
  /** Case-insensitive name substring filter. */
  query?: string;
  compositionId?: string;
  offset: number;
  limit: number;
}

/** Filters and paginates before shaping, so large projects never build a whole-project context. */
export function queryValues(
  project: Project,
  request: ProjectQuery,
): { total: number; items: unknown[]; compositionId?: string } {
  const composition = queryComposition(project, request.compositionId);
  const needle = request.query?.toLocaleLowerCase();
  const named = <T extends { name: string }>(values: readonly T[]) =>
    needle ? values.filter((value) => value.name.toLocaleLowerCase().includes(needle)) : values;
  const page = <T>(values: readonly T[]) => ({
    total: values.length,
    items: values.slice(request.offset, request.offset + request.limit),
  });
  const layers = () => named(composition.layers);
  const sliced = (values: readonly Composition["layers"][number][]) => ({
    ...composition,
    layers: values.slice(request.offset, request.offset + request.limit),
  });
  switch (request.kind) {
    case "project":
      return {
        total: 1,
        items: [
          {
            id: project.id,
            name: project.name,
            activeCompositionId: project.activeCompositionId,
            compositionCount: project.compositions.length,
            sourceCount: project.sources.length,
            fontCount: project.fonts?.length ?? 0,
          },
        ],
      };
    case "compositions":
      return page(
        named(project.compositions).map((candidate) => ({
          id: candidate.id,
          name: candidate.name,
          width: candidate.width,
          height: candidate.height,
          duration: candidate.duration,
          frameRate: candidate.frameRate.numerator / candidate.frameRate.denominator,
          layerCount: candidate.layers.length,
          active: candidate.id === project.activeCompositionId,
          usedBy: project.compositions
            .filter((parent) =>
              parent.layers.some((layer) => layer.sourceCompositionId === candidate.id),
            )
            .map((parent) => parent.id)
            .slice(0, 8),
        })),
      );
    case "layers": {
      const matching = layers();
      const byId = new Map(matching.map((layer) => [layer.id, layer]));
      return {
        compositionId: composition.id,
        total: matching.length,
        items: queryTimeline(sliced(matching)).map((item) => {
          const layer = byId.get(item.id);
          return {
            ...item,
            ...(layer?.sourceId ? { sourceId: layer.sourceId } : {}),
            ...(layer?.sourceCompositionId
              ? { sourceCompositionId: layer.sourceCompositionId }
              : {}),
          };
        }),
      };
    }
    case "properties": {
      const selected = request.query
        ? layers().map((layer) => layer.id)
        : request.selection.filter((id) => composition.layers.some((layer) => layer.id === id));
      return {
        compositionId: composition.id,
        ...page(queryProperties(composition, selected.slice(0, 16), request.time)),
      };
    }
    case "effects":
      return {
        compositionId: composition.id,
        ...page(queryEffects({ ...composition, layers: [...layers()] }, request.time)),
      };
    case "assets": {
      const sources = named(project.sources);
      return {
        total: sources.length,
        items: queryAssets({
          ...project,
          sources: sources.slice(request.offset, request.offset + request.limit),
        }),
      };
    }
    case "fonts":
      return page((project.fonts ?? []).map(projectFontMetadata));
    case "scene":
      return {
        compositionId: composition.id,
        ...page(queryScene(project, composition, request.time)),
      };
    default:
      throw new Error(
        `Unsupported project query kind: ${request.kind}. Use project, compositions, layers, properties, effects, assets, fonts or scene.`,
      );
  }
}

function queryComposition(project: Project, compositionId: string | undefined): Composition {
  if (!compositionId) return activeComposition(project);
  const composition = project.compositions.find((candidate) => candidate.id === compositionId);
  if (!composition) throw new Error(`Composition does not exist: ${compositionId}`);
  return composition;
}

export function changedIdsForOperation(operation: Operation): string[] {
  if ("layerId" in operation) return [operation.layerId];
  if ("compositionId" in operation) return [operation.compositionId];
  if (operation.type === "addLayer") return [operation.layer.id];
  if (operation.type === "addComposition") return [operation.composition.id];
  if (operation.type === "addProjectFolder") return [operation.folder.id];
  if (operation.type === "addProjectFont") return [operation.font.id];
  if (operation.type === "removeProjectFont") return [operation.fontId];
  if (operation.type === "moveProjectItem") return [operation.itemId];
  if (operation.type === "precomposeLayers")
    return [operation.wrapper.id, operation.nestedComposition.id, ...operation.selectedIds];
  return [];
}

export function boundedResult<T>(value: T): T {
  if (encodedBytes(value) > Math.min(MAX_QUERY_BYTES, MAX_AI_CONTEXT_BYTES))
    throw new Error("Agent query result exceeded its byte budget");
  return value;
}

export function assertRenderedFrames(
  frames: readonly AgentRenderedPreviewFrame[],
  times: readonly number[],
): void {
  if (frames.length !== times.length) throw new Error("Agent preview renderer omitted frames");
  let encodedCharacters = 0;
  for (const [index, frame] of frames.entries()) {
    if (frame.time !== times[index]) throw new Error("Agent preview renderer changed sample times");
    if (!frame.renderId || frame.renderId.length > 256)
      throw new Error("Agent preview render ID is invalid");
    if (frame.mimeType !== "image/png") throw new Error("Agent preview format is unsupported");
    if (
      !Number.isSafeInteger(frame.width) ||
      !Number.isSafeInteger(frame.height) ||
      frame.width < 1 ||
      frame.height < 1 ||
      frame.width > 2048 ||
      frame.height > 2048
    )
      throw new Error("Agent preview dimensions are outside their bounds");
    if (!/^[A-Za-z0-9+/]*={0,2}$/u.test(frame.data))
      throw new Error("Agent preview image is not base64 encoded");
    encodedCharacters += frame.data.length;
    for (const value of Object.values(frame.measurements))
      if (typeof value === "number" && !Number.isFinite(value))
        throw new Error("Agent preview measurement is not finite");
  }
  if (encodedCharacters > 12 * 1024 * 1024)
    throw new Error("Agent preview transport exceeded its byte budget");
}

export function frameMeasurement(frame: AgentRenderedPreviewFrame) {
  return {
    time: frame.time,
    renderId: frame.renderId,
    width: frame.width,
    height: frame.height,
    ...frame.measurements,
  };
}

export function boundedTimes(value: unknown): number[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_RENDER_SAMPLES)
    throw new Error(`times must contain 1 through ${MAX_RENDER_SAMPLES} entries`);
  return [...new Set(value.map((entry) => finiteNumber(entry, "time")))].sort(
    (left, right) => left - right,
  );
}

export function stringValue(value: unknown, name: string, allowEmpty = false): string {
  if (typeof value !== "string" || (!allowEmpty && !value.trim()))
    throw new Error(`${name} must be a non-empty string`);
  if (value.length > 500) throw new Error(`${name} is too long`);
  return value;
}

export function optionalString(value: unknown, name: string): string | undefined {
  return value === undefined ? undefined : stringValue(value, name);
}

export function finiteNumber(value: unknown, name: string, fallback?: number): number {
  if (value === undefined && fallback !== undefined) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value))
    throw new Error(`${name} must be finite`);
  return value;
}

export function boundedInteger(
  value: unknown,
  name: string,
  minimum: number,
  maximum: number,
  fallback?: number,
): number {
  if (value === undefined && fallback !== undefined) return fallback;
  if (typeof value !== "number" || !Number.isSafeInteger(value))
    throw new Error(`${name} must be an integer`);
  if (value < minimum || value > maximum) throw new Error(`${name} is outside its bounds`);
  return value;
}
