import { describe, expect, it } from "vitest";
import type { BeatAnalysis } from "../core/audio/beat-analysis";
import { applyOperations } from "../core/editing/operations";
import { createLayerForComposition } from "../core/layers/layer-factory";
import { createBlankProject } from "../core/project/project";
import { validateProjectDocument } from "../core/project/project-file";
import { beatSummary, mapAnalysisToLayer, markersFromAnalysis } from "./beat-markers";

const analysis: BeatAnalysis = {
  bpm: 120,
  offset: 0.5,
  confidence: 0.9,
  beats: [0.5, 1, 1.5, 2, 2.5, 3],
  downbeats: [0.5, 2.5],
  downbeatPhase: 0,
  sections: [
    { start: 0, end: 2, energy: 0.2 },
    { start: 2, end: 4, energy: 0.8 },
  ],
  duration: 4,
};

describe("beat markers", () => {
  it("maps source beats onto a trimmed, stretched layer and exposes expression snippets", () => {
    const project = createBlankProject();
    const layer = createLayerForComposition("audio", project.compositions[0], 0);
    Object.assign(layer, { inPoint: 10, outPoint: 12, timeOffset: 1, timeStretch: 2 });
    const mapped = mapAnalysisToLayer(analysis, layer);
    expect(mapped.bpm).toBe(60);
    expect(mapped.beats).toEqual([10, 11]);
    expect(mapped.downbeats).toEqual([]);
    expect(mapped.sections).toEqual([{ start: 10, end: 12, energy: 0.2 }]);
    expect(beatSummary(analysis).expressions.beatPulse).toBe("pow(1 - beatphase(120, 0.5), 3)");
  });

  it("replaces analyzed markers, keeps custom cues, and validates as project data", () => {
    let id = 0;
    const markers = markersFromAnalysis(
      analysis,
      [
        { id: "cue", time: 1.2, kind: "marker", label: "Drop" },
        { id: "old", time: 0.1, kind: "beat" },
      ],
      10,
      () => `m${id++}`,
    );
    expect(markers.map((marker) => marker.kind)).toEqual([
      "section",
      "downbeat",
      "beat",
      "marker",
      "beat",
      "beat",
      "section",
      "downbeat",
      "beat",
    ]);
    const project = createBlankProject();
    const composition = project.compositions[0];
    const next = applyOperations(project, [
      { type: "setCompositionMarkers", compositionId: composition.id, markers },
    ]);
    expect(validateProjectDocument(next).compositions[0].markers).toHaveLength(9);
    const cleared = applyOperations(next, [
      { type: "setCompositionMarkers", compositionId: composition.id, markers: [] },
    ]);
    expect(cleared.compositions[0].markers).toBeUndefined();
    const invalid = structuredClone(next);
    invalid.compositions[0].markers?.reverse();
    expect(() => validateProjectDocument(invalid)).toThrow("sorted");
  });
});
