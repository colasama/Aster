import { describe, expect, it } from "vitest";
import {
  audibleCompositionLayers,
  evaluateLayerAudioSourceTime,
  mixCompositionAudio,
} from "./audio-mixer";
import { createLayerForComposition } from "./layer-factory";
import { activeComposition, createDemoProject } from "./project";

describe("composition audio mixing", () => {
  it("maps offset, stretch, bounds, and reverse without playback history", () => {
    const composition = activeComposition(createDemoProject());
    const layer = createLayerForComposition("audio", composition, 2);
    layer.outPoint = 6;
    layer.timeOffset = 1;
    layer.timeStretch = 2;
    expect(evaluateLayerAudioSourceTime(layer, 1.99, 10)).toBeUndefined();
    expect(evaluateLayerAudioSourceTime(layer, 4, 10)).toBe(2);
    if (!layer.audio) throw new Error("Expected audio layer settings");
    layer.audio = { ...layer.audio, reversed: true };
    expect(evaluateLayerAudioSourceTime(layer, 4, 10)).toBe(8);
    expect(evaluateLayerAudioSourceTime(layer, 6, 10)).toBeUndefined();
  });

  it("keeps audio and video solo groups independent like AE layer types", () => {
    const composition = activeComposition(createDemoProject());
    const audio = createLayerForComposition("audio", composition);
    const otherAudio = createLayerForComposition("audio", composition);
    const video = createLayerForComposition("video", composition);
    audio.solo = true;
    composition.layers = [audio, otherAudio, video];
    expect(audibleCompositionLayers(composition)).toEqual([audio, video]);
  });

  it("mixes stereo float32, applies dB/pan, and protects the master from clipping", () => {
    const project = createDemoProject();
    const composition = activeComposition(project);
    composition.duration = 1;
    const source = {
      id: "tone",
      kind: "audio" as const,
      name: "Tone.wav",
      mimeType: "audio/wav",
      contentIdentity: "sha256:tone",
      duration: 1,
      channels: 2,
      sampleRate: 8_000,
      streamIndex: 0,
      interpretation: { alpha: "ignore" as const, colorSpace: "srgb" as const },
    };
    project.sources = [source];
    const layer = createLayerForComposition("audio", composition);
    layer.sourceId = source.id;
    layer.outPoint = 1;
    layer.audio = { levelsDb: [6, 6], pan: 0, muted: false, reversed: false };
    composition.layers = [layer];
    const decoded = new Map([
      [
        source.id,
        {
          sampleRate: 8_000,
          channels: [new Float32Array(8_000).fill(1), new Float32Array(8_000).fill(1)],
        },
      ],
    ]);
    const result = mixCompositionAudio(project, composition, decoded, {
      startTime: 0,
      endTime: 1,
      sampleRate: 8_000,
    });
    expect(result.frameCount).toBe(8_000);
    expect(result.peak).toBeGreaterThan(1);
    expect(Math.max(...result.samples)).toBeCloseTo(0.999, 5);
  });
});
