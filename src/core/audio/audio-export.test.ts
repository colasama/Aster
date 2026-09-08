import { describe, expect, it, vi } from "vitest";
import { createLayerForComposition } from "../layers/layer-factory";
import { activeComposition, createDemoProject } from "../project/project";
import {
  alignedAudioFrameCount,
  decodeAudibleSources,
  mixAudioExportChunk,
  streamCompositionAudio,
} from "./audio-export";

function audioProject() {
  const project = createDemoProject();
  const composition = activeComposition(project);
  composition.duration = 0.5;
  const source = {
    id: "audio-source",
    kind: "audio" as const,
    name: "Tone.wav",
    mimeType: "audio/wav",
    contentIdentity: "sha256:tone",
    duration: 0.5,
    channels: 1,
    sampleRate: 8_000,
    streamIndex: 0,
    interpretation: { alpha: "ignore" as const, colorSpace: "srgb" as const },
  };
  project.sources = [source];
  const first = createLayerForComposition("audio", composition);
  first.sourceId = source.id;
  first.outPoint = composition.duration;
  const second = { ...first, id: "second-layer" };
  composition.layers = [first, second];
  return { project, composition, source };
}

describe("audio export", () => {
  it("derives PCM length from the rational video timeline", () => {
    expect(alignedAudioFrameCount(1_800, { numerator: 30_000, denominator: 1_001 })).toBe(
      2_882_880,
    );
  });

  it("decodes a shared source once for multiple layer instances", async () => {
    const { project, composition } = audioProject();
    const decode = vi.fn(async () => ({
      sampleRate: 8_000,
      channels: [new Float32Array(4_000)],
    }));
    const result = await decodeAudibleSources(project, composition, decode);
    expect(decode).toHaveBeenCalledTimes(1);
    expect(result.size).toBe(1);
  });

  it("streams bounded stereo chunks and pads rational video tail with silence", async () => {
    const { project, composition, source } = audioProject();
    composition.layers = [composition.layers[0]];
    const decoded = new Map([
      [source.id, { sampleRate: 8_000, channels: [new Float32Array(4_000).fill(1)] }],
    ]);
    const tail = mixAudioExportChunk(project, composition, decoded, 3_998, 4, 8_000);
    expect([...tail]).toEqual([1, 1, 1, 1, 0, 0, 0, 0]);

    const writes: number[] = [];
    const completed = await streamCompositionAudio(
      project,
      composition,
      decoded,
      48_001,
      async (samples) => {
        writes.push(samples.length / 2);
      },
      () => false,
    );
    expect(completed).toBe(48_001);
    expect(writes).toEqual([48_000, 1]);
  });

  it("mixes a background range from its exact rational composition start", () => {
    const { project, composition, source } = audioProject();
    composition.layers = [composition.layers[0]];
    const samples = new Float32Array(4_000);
    samples[2_000] = 0.75;
    const decoded = new Map([[source.id, { sampleRate: 8_000, channels: [samples] }]]);
    const ranged = mixAudioExportChunk(project, composition, decoded, 0, 2, 8_000, 0.25);
    expect([...ranged]).toEqual([0.75, 0.75, 0, 0]);
  });
});
