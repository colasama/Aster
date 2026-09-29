import type { BeatAnalysis } from "../core/audio/beat-analysis.js";

/** Agent-facing analysis with ready-to-paste expression snippets. */
export function beatSummary(analysis: BeatAnalysis) {
  const barOffset = analysis.downbeats[0] ?? analysis.offset;
  return {
    bpm: analysis.bpm,
    offset: analysis.offset,
    confidence: analysis.confidence,
    beatCount: analysis.beats.length,
    beats: analysis.beats,
    downbeats: analysis.downbeats,
    sections: analysis.sections,
    duration: analysis.duration,
    expressions: {
      beatPulse: `pow(1 - beatphase(${analysis.bpm}, ${analysis.offset}), 3)`,
      barPhase: `beatphase(${round(analysis.bpm / 4)}, ${barOffset})`,
      beatIndex: `beat(${analysis.bpm}, ${analysis.offset})`,
    },
  };
}

function round(value: number, digits = 4): number {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}
