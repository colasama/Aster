import { describe, expect, it, vi } from "vitest";
import { createLayerForComposition } from "../layers/layer-factory";
import { activeComposition, createDemoProject } from "../project/project";
import type { Project } from "../types";
import { AUDIO_ANALYSIS_FLAG_PENDING, AUDIO_ANALYSIS_FLAG_PRESENT } from "./audio-analysis-frame";
import { AudioAnalysisProvider } from "./audio-analysis-provider";
import type { DecodedPcm } from "./audio-mixer";

const SAMPLE_RATE = 48_000;

function projectWithTone(): Project {
  const project = createDemoProject();
  const composition = activeComposition(project);
  composition.duration = 2;
  project.sources = [
    {
      id: "tone",
      kind: "audio",
      name: "Tone.wav",
      mimeType: "audio/wav",
      contentIdentity: "sha256:tone",
      duration: 2,
      channels: 2,
      sampleRate: SAMPLE_RATE,
      streamIndex: 0,
      interpretation: { alpha: "ignore", colorSpace: "srgb" },
    },
  ];
  const layer = createLayerForComposition("audio", composition);
  layer.sourceId = "tone";
  layer.outPoint = 2;
  composition.layers = [layer];
  return project;
}

function tone(): DecodedPcm {
  const samples = Float32Array.from(
    { length: SAMPLE_RATE * 2 },
    (_, index) => 0.5 * Math.sin((2 * Math.PI * 1_000 * index) / SAMPLE_RATE),
  );
  return { sampleRate: SAMPLE_RATE, channels: [samples, samples] };
}

function flags(frame: Float32Array): number {
  return new Uint32Array(frame.buffer, 0, 4)[3];
}

describe("audio analysis provider", () => {
  it("holds frames while sources decode, then analyzes the heard mix", async () => {
    const project = projectWithTone();
    const composition = activeComposition(project);
    let resolve: (pcm: DecodedPcm) => void = () => undefined;
    const decode = vi.fn(
      () =>
        new Promise<DecodedPcm>((done) => {
          resolve = done;
        }),
    );
    const onReady = vi.fn();
    const provider = new AudioAnalysisProvider(onReady, decode);

    expect(flags(provider.frame(project, composition, 1)) & AUDIO_ANALYSIS_FLAG_PENDING).toBe(
      AUDIO_ANALYSIS_FLAG_PENDING,
    );
    expect(provider.hasPendingFrameResources).toBe(true);
    provider.frame(project, composition, 1.5);
    expect(decode).toHaveBeenCalledOnce();

    const waited = provider.waitForFrameResources();
    resolve(tone());
    await waited;
    expect(onReady).toHaveBeenCalledOnce();
    expect(provider.hasPendingFrameResources).toBe(false);
    const ready = provider.frame(project, composition, 1);
    expect(flags(ready)).toBe(AUDIO_ANALYSIS_FLAG_PRESENT);
    expect(ready[9]).toBeCloseTo(0.5, 2);
  });

  it("treats compositions without audible layers and failed decodes as silence", async () => {
    const project = projectWithTone();
    const composition = activeComposition(project);
    const silent = new AudioAnalysisProvider(() => undefined, vi.fn());
    expect(flags(silent.frame(project, { ...composition, layers: [] }, 1))).toBe(0);

    const failing = new AudioAnalysisProvider(
      () => undefined,
      vi.fn(() => Promise.reject(new Error("corrupt"))),
    );
    failing.frame(project, composition, 1);
    await failing.waitForFrameResources();
    const frame = failing.frame(project, composition, 1);
    expect(flags(frame)).toBe(AUDIO_ANALYSIS_FLAG_PRESENT);
    expect(frame[9]).toBe(0);
  });
});
