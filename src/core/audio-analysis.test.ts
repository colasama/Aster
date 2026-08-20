import { describe, expect, it } from "vitest";
import {
  analyzeSpectrum,
  applyAudioVolume,
  buildWaveformPeaks,
  decibelsToGain,
  effectiveAudioGain,
  gainToDecibels,
  MAX_FFT_SIZE,
  normalizeAudioVolume,
} from "./audio-analysis";

describe("audio analysis", () => {
  it("builds GPU-aligned peak, RMS, and coverage records", () => {
    const peaks = buildWaveformPeaks(new Float32Array([-1, 0.5, -0.25, 1]), 2);
    expect(peaks.length).toBe(8);
    expect(Array.from(peaks)).toEqual([
      -1,
      0.5,
      Math.fround(Math.sqrt(0.625)),
      2,
      -0.25,
      1,
      Math.fround(Math.sqrt(0.53125)),
      2,
    ]);
  });

  it("keeps empty peak bins deterministic and sanitizes invalid PCM", () => {
    const peaks = buildWaveformPeaks(new Float32Array([Number.NaN, 1]), 4);
    expect(Array.from(peaks)).toEqual([0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 1, 1, 1]);
  });

  it("finds an exact-bin sinusoid with normalized magnitude", () => {
    const fftSize = 1_024;
    const targetBin = 64;
    const samples = Float32Array.from({ length: fftSize }, (_, index) =>
      Math.sin((2 * Math.PI * targetBin * index) / fftSize),
    );
    const spectrum = analyzeSpectrum(samples, fftSize, {
      fftSize,
      window: "rectangular",
    });
    expect(spectrum.length).toBe((fftSize / 2 + 1) * 4);
    expect(spectrum[targetBin * 4]).toBe(targetBin);
    expect(spectrum[targetBin * 4 + 1]).toBeCloseTo(1, 5);
    expect(spectrum[targetBin * 4 + 2]).toBeCloseTo(1, 5);
    expect(spectrum[(targetBin - 1) * 4 + 1]).toBeLessThan(0.000_01);
  });

  it("zero pads bounded windows and rejects unsafe FFT sizes", () => {
    const spectrum = analyzeSpectrum(new Float32Array([1]), 48_000, {
      fftSize: 8,
      startSample: 1,
    });
    expect(Array.from(spectrum).every(Number.isFinite)).toBe(true);
    expect(() => analyzeSpectrum(new Float32Array(), 48_000, { fftSize: 12 })).toThrow(
      "power of two",
    );
    expect(() =>
      analyzeSpectrum(new Float32Array(), 48_000, { fftSize: MAX_FFT_SIZE * 2 }),
    ).toThrow("fftSize");
  });

  it("normalizes volume state and applies gain without mutating PCM", () => {
    const samples = new Float32Array([0.25, -0.5]);
    expect(normalizeAudioVolume({ gain: 8, muted: false })).toEqual({ gain: 4, muted: false });
    expect(effectiveAudioGain({ gain: 2, muted: true })).toBe(0);
    expect(Array.from(applyAudioVolume(samples, { gain: 2, muted: false }))).toEqual([0.5, -1]);
    expect(Array.from(samples)).toEqual([0.25, -0.5]);
    expect(Array.from(applyAudioVolume(samples, { gain: 2, muted: true }))).toEqual([0, 0]);
  });

  it("converts linear gain and decibels", () => {
    expect(gainToDecibels(0.5)).toBeCloseTo(-6.0206, 4);
    expect(decibelsToGain(-6.0206)).toBeCloseTo(0.5, 4);
    expect(gainToDecibels(0)).toBe(Number.NEGATIVE_INFINITY);
    expect(decibelsToGain(Number.NEGATIVE_INFINITY)).toBe(0);
  });
});
