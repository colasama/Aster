import { describe, expect, it } from "vitest";
import { analyzeBeats } from "./beat-analysis";

/** Clicks at a fixed tempo; every fourth beat adds a bass thump; the second half is louder. */
function track(bpm: number, offset: number, seconds: number, sampleRate = 22_050) {
  const samples = new Float32Array(Math.round(seconds * sampleRate));
  const period = 60 / bpm;
  for (let beat = 0, time = offset; time < seconds; beat++, time = offset + beat * period) {
    const start = Math.round(time * sampleRate);
    const gain = time > seconds / 2 ? 1 : 0.35;
    for (let index = 0; index < sampleRate * 0.08 && start + index < samples.length; index++) {
      const t = index / sampleRate;
      const decay = Math.exp(-t * 40);
      let value = 0.6 * Math.sin(2 * Math.PI * 1800 * t) * decay;
      if (beat % 4 === 1) value += 0.9 * Math.sin(2 * Math.PI * 60 * t) * Math.exp(-t * 12);
      samples[start + index] += gain * value;
    }
  }
  return { samples, sampleRate };
}

describe("beat analysis", () => {
  it("recovers tempo, grid phase, bass downbeats and a loudness section change", () => {
    const { samples, sampleRate } = track(128, 0.3, 60);
    const result = analyzeBeats(samples, sampleRate);
    expect(result.bpm).toBeCloseTo(128, 0);
    const period = 60 / result.bpm;
    const phaseError = Math.abs(((result.offset - 0.3 + period / 2) % period) - period / 2);
    expect(phaseError).toBeLessThan(0.02);
    expect(result.beats.length).toBeGreaterThan(120);
    // Accented beats are 0.3 + (4k + 1) * period.
    const accent = 0.3 + period;
    for (const downbeat of result.downbeats.slice(0, 5)) {
      const beats = (downbeat - accent) / period;
      expect(Math.abs(beats - 4 * Math.round(beats / 4))).toBeLessThan(0.1);
    }
    expect(result.sections.length).toBeGreaterThanOrEqual(2);
    expect(result.sections.some((section) => Math.abs(section.start - 30) < 2)).toBe(true);
  });

  it("stays in range for fast tempi and rejects very short input", () => {
    const { samples, sampleRate } = track(152, 0.49, 40);
    expect(analyzeBeats(samples, sampleRate).bpm).toBeCloseTo(152, 0);
    expect(() => analyzeBeats(new Float32Array(100), 44_100)).toThrow("at least one second");
  });
});
