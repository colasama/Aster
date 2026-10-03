import { AUDIO_ANALYSIS_SAMPLE_RATE } from "../../src/core/audio/audio-analysis-frame";
import { sharedAudioDecodeCache } from "../../src/core/audio/audio-decode-cache";
import { audibleCompositionLayers } from "../../src/core/audio/audio-mixer";
import { sourceLocator } from "../../src/core/media/footage-source";
import {
  getLoadedPluginIds,
  setProjectPluginRuntimes,
} from "../../src/core/plugins/plugin-runtime";
import type { PluginStatus } from "../../src/core/plugins/plugins";
import { projectPluginReferences } from "../../src/core/project/project-plugin-references";
import type { Composition, FootageSource, Project } from "../../src/core/types";
import { mediaImportRuntime } from "../../src/importers/media-import-runtime";
import type { ParityCaptureAssignment } from "./capture-protocol";

export function captureComposition(
  assignment: ParityCaptureAssignment,
  project: Project,
): Composition {
  const composition = project.compositions.find(
    (value) => value.id === assignment.case.composition,
  );
  if (!composition) throw new Error(`Missing capture composition ${assignment.case.composition}`);
  const { width, height } = assignment.case.size;
  if (![width, height].every((value) => Number.isSafeInteger(value) && value > 0))
    throw new Error("Capture dimensions must be positive integers");
  const { numerator, denominator } = composition.frameRate;
  if (![numerator, denominator].every((value) => Number.isSafeInteger(value) && value > 0))
    throw new Error("Capture requires a positive rational frame rate");
  const frameCount = Math.ceil((composition.duration * numerator) / denominator);
  if (
    assignment.frames.length === 0 ||
    assignment.frames.some(
      (frame) => !Number.isSafeInteger(frame) || frame < 0 || frame >= frameCount,
    )
  )
    throw new Error("Capture frame addresses are outside the composition");
  return composition;
}

export function reachableCompositions(project: Project, root: Composition): Composition[] {
  const visited = new Set<string>();
  const compositions: Composition[] = [];
  const visit = (composition: Composition) => {
    if (visited.has(composition.id)) return;
    visited.add(composition.id);
    compositions.push(composition);
    for (const layer of composition.layers) {
      if (!layer.sourceCompositionId) continue;
      const nested = project.compositions.find((item) => item.id === layer.sourceCompositionId);
      if (!nested) throw new Error(`Missing precomposition ${layer.sourceCompositionId}`);
      visit(nested);
    }
  };
  visit(root);
  return compositions;
}

export function assertCaptureMedia(project: Project, composition: Composition): void {
  const sourceIds = new Set(
    reachableCompositions(project, composition).flatMap((item) =>
      item.layers.flatMap((layer) => (layer.sourceId ? [layer.sourceId] : [])),
    ),
  );
  for (const id of sourceIds) {
    const source = project.sources.find((item) => item.id === id);
    if (!source) throw new Error(`Capture media source ${id} is missing`);
    const error = mediaImportRuntime.error(id);
    if (error) throw new Error(`Capture media ${source.name}: ${error}`);
    if (!sourceLocator(source))
      throw new Error(`Capture media ${source.name} has no hydrated locator`);
    if (
      ["svg", "psd", "imageSequence"].includes(source.kind) &&
      mediaImportRuntime.get(id)?.kind !== source.kind
    )
      throw new Error(`Capture media ${source.name} has no hydrated ${source.kind} payload`);
  }
}

export async function prepareCapturePlugins(project: Project): Promise<PluginStatus | undefined> {
  const requested = projectPluginReferences(project);
  const status = await setProjectPluginRuntimes(requested);
  assertCapturePlugins(requested, status, getLoadedPluginIds());
  return status;
}

export function assertCapturePlugins(
  requested: readonly string[],
  status: PluginStatus | undefined,
  loaded: ReadonlySet<string>,
): void {
  if (requested.length === 0) return;
  if (!status?.native || status.safeMode)
    throw new Error("Capture plugins require an active native runtime");
  if (status.report.failures.length)
    throw new Error(`Capture plugin validation failed: ${JSON.stringify(status.report.failures)}`);
  for (const id of requested) {
    if (status.disabled.includes(id) || !loaded.has(id) || !status.report.shader_sources?.[id])
      throw new Error(`Capture plugin ${id} has no enabled validated shader runtime`);
  }
}

/** Populate the same decode cache used by production analysis, retaining decode failures. */
export async function prepareCaptureAudio(
  project: Project,
  composition: Composition,
): Promise<void> {
  const sourceById = new Map(project.sources.map((source) => [source.id, source]));
  const sources = new Map<string, FootageSource>();
  for (const item of reachableCompositions(project, composition)) {
    for (const layer of audibleCompositionLayers(item)) {
      const source = layer.sourceId ? sourceById.get(layer.sourceId) : undefined;
      if (!source || (source.kind !== "audio" && source.kind !== "video"))
        throw new Error(`Audio analysis layer ${layer.name} has no audio source`);
      if (source.kind === "video" && !source.audio) continue;
      sources.set(source.contentIdentity, source);
    }
  }
  if (sources.size === 0) throw new Error("Audio-analysis capture has no audible sources");
  const context = new OfflineAudioContext(2, 1, AUDIO_ANALYSIS_SAMPLE_RATE);
  for (const source of sources.values()) {
    const decoded = await sharedAudioDecodeCache.decode(context, source);
    if (decoded.length < 1 || decoded.numberOfChannels < 1)
      throw new Error(`Audio-analysis source ${source.name} decoded without samples`);
  }
}
