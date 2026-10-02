import { describe, expect, it } from "vitest";
import {
  AUDIO_ANALYSIS_BANDS,
  AUDIO_ANALYSIS_BYTES,
  AUDIO_ANALYSIS_FLAG_PENDING,
  AUDIO_ANALYSIS_FLAG_PRESENT,
  AUDIO_ANALYSIS_HISTORY,
  AUDIO_ANALYSIS_SAMPLE_RATE,
  AUDIO_ANALYSIS_WAVEFORM,
  audioAnalysisBandFrequency,
  buildAudioAnalysisFrame,
  type MonoAudioReader,
} from "./audio-analysis-frame";

const SPECTRUM = 16;
const WAVEFORM = SPECTRUM + AUDIO_ANALYSIS_BANDS * AUDIO_ANALYSIS_HISTORY;

function sineReader(frequency: number, amplitude: number, until = Number.POSITIVE_INFINITY) {
  const reads: Array<[number, number]> = [];
  const read: MonoAudioReader = (start, length) => {
    reads.push([start, length]);
    return Float32Array.from({ length }, (_, index) => {
      const sample = start + index;
      return sample < 0 || sample / AUDIO_ANALYSIS_SAMPLE_RATE >= until
        ? 0
        : amplitude * Math.sin((2 * Math.PI * frequency * sample) / AUDIO_ANALYSIS_SAMPLE_RATE);
    });
  };
  return { read, reads };
}

function bandsAt(frame: Float32Array, history: number): Float32Array {
  return frame.subarray(
    SPECTRUM + history * AUDIO_ANALYSIS_BANDS,
    SPECTRUM + (history + 1) * AUDIO_ANALYSIS_BANDS,
  );
}

describe("scene-generator audio analysis frame", () => {
  it("packs the ABI header and stays silent without audio", () => {
    const frame = buildAudioAnalysisFrame(undefined, 2.5, { flags: AUDIO_ANALYSIS_FLAG_PENDING });
    expect(frame.byteLength).toBe(AUDIO_ANALYSIS_BYTES);
    expect(AUDIO_ANALYSIS_BYTES).toBe(9_280);
    expect([...new Uint32Array(frame.buffer, 0, 4)]).toEqual([
      AUDIO_ANALYSIS_BANDS,
      AUDIO_ANALYSIS_HISTORY,
      AUDIO_ANALYSIS_WAVEFORM,
      AUDIO_ANALYSIS_FLAG_PENDING,
    ]);
    expect(frame[4]).toBe(2.5);
    expect(frame.subarray(8).every((value) => value === 0)).toBe(true);
  });

  it("places a tone in its log band with normalized level, energy, and waveform", () => {
    const { read } = sineReader(1_000, 0.5);
    const frame = buildAudioAnalysisFrame(read, 1);
    expect(new Uint32Array(frame.buffer, 0, 4)[3]).toBe(AUDIO_ANALYSIS_FLAG_PRESENT);
    const bands = bandsAt(frame, 0);
    const loudest = bands.indexOf(Math.max(...bands));
    expect(audioAnalysisBandFrequency(loudest) / 1_000).toBeGreaterThan(0.95);
    expect(audioAnalysisBandFrequency(loudest) / 1_000).toBeLessThan(1.05);
    // A -6 dBFS sine maps to (90 - 6) / 90 on the band scale.
    expect(bands[loudest]).toBeCloseTo(84 / 90, 1);
    expect(frame[8]).toBeCloseTo(0.5 / Math.SQRT2, 2);
    expect(frame[9]).toBeCloseTo(0.5, 2);
    expect(frame[13]).toBeGreaterThan(frame[12]);
    expect(frame[13]).toBeGreaterThan(frame[14]);
    const waveform = frame.subarray(WAVEFORM, WAVEFORM + AUDIO_ANALYSIS_WAVEFORM);
    expect(Math.max(...waveform)).toBeGreaterThan(0.45);
    expect(Math.min(...waveform)).toBeLessThan(-0.45);
  });

  it("addresses history by time so releases and seeks are deterministic", () => {
    const { read } = sineReader(440, 0.8, 1);
    const afterStop = buildAudioAnalysisFrame(read, 1.1);
    // The tone stopped at 1 s: frame 0 hears silence, frame 12 (0.2 s earlier) still hears it.
    expect(Math.max(...bandsAt(afterStop, 12))).toBeGreaterThan(Math.max(...bandsAt(afterStop, 0)));
    expect(buildAudioAnalysisFrame(read, 0.75)).toEqual(buildAudioAnalysisFrame(read, 0.75));
  });

  it("reuses cached band vectors across neighbouring frames", () => {
    const cache = new Map<number, Float32Array>();
    const first = sineReader(220, 0.3);
    buildAudioAnalysisFrame(first.read, 1, { bandCache: cache });
    expect(cache.size).toBe(AUDIO_ANALYSIS_HISTORY);
    const second = sineReader(220, 0.3);
    buildAudioAnalysisFrame(second.read, 1 + 2 / 60, { bandCache: cache });
    expect(second.reads.filter(([, length]) => length === 4_096)).toHaveLength(2);
  });
});
