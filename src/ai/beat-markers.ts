import type { BeatAnalysis } from "../core/audio/beat-analysis";
import type { CompositionMarker, Layer } from "../core/types";

export { beatSummary } from "./beat-summary";

/**
 * Maps source-time analysis onto the composition clock of a layer that plays the source:
 * compositionTime = inPoint + (sourceTime - timeOffset) * stretch, keeping in-range events only.
 */
export function mapAnalysisToLayer(analysis: BeatAnalysis, layer: Layer): BeatAnalysis {
  const stretch = Math.max(0.01, layer.timeStretch ?? 1);
  const offset = layer.timeOffset ?? 0;
  const toComposition = (time: number) => round(layer.inPoint + (time - offset) * stretch);
  const inside = (time: number) => time >= layer.inPoint && time < layer.outPoint;
  const beats = analysis.beats.map(toComposition).filter(inside);
  const downbeats = analysis.downbeats.map(toComposition).filter(inside);
  const sections = analysis.sections
    .map((section) => ({
      ...section,
      start: Math.max(layer.inPoint, toComposition(section.start)),
      end: Math.min(layer.outPoint, toComposition(section.end)),
    }))
    .filter((section) => section.end > section.start);
  return {
    ...analysis,
    bpm: round(analysis.bpm / stretch, 2),
    offset: toComposition(analysis.offset),
    beats,
    downbeats,
    sections,
  };
}

/** Replaces analyzed marker kinds while keeping custom markers. */
export function markersFromAnalysis(
  analysis: BeatAnalysis,
  existing: readonly CompositionMarker[] | undefined,
  duration: number,
  createId: () => string,
): CompositionMarker[] {
  const downbeats = new Set(analysis.downbeats);
  const analyzed: CompositionMarker[] = [
    ...analysis.beats.map((time) => ({
      id: createId(),
      time,
      kind: downbeats.has(time) ? ("downbeat" as const) : ("beat" as const),
    })),
    ...analysis.sections.map((section, index) => ({
      id: createId(),
      time: section.start,
      kind: "section" as const,
      label: `Section ${index + 1} · energy ${section.energy}`,
    })),
  ];
  const custom = (existing ?? []).filter((marker) => marker.kind === "marker");
  return [...custom, ...analyzed]
    .filter((marker) => marker.time >= 0 && marker.time <= duration)
    .sort((left, right) => left.time - right.time)
    .slice(0, 4096);
}

function round(value: number, digits = 4): number {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}
