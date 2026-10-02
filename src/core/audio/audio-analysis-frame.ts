import { analyzeSpectrum } from "./audio-analysis";

/** Log-spaced spectrum bands per history frame in the scene-generator audio ABI v1. */
export const AUDIO_ANALYSIS_BANDS = 128;
/** Frames of band history; frame 0 is the evaluated time, frame k is k hops earlier. */
export const AUDIO_ANALYSIS_HISTORY = 16;
export const AUDIO_ANALYSIS_WAVEFORM = 256;
export const AUDIO_ANALYSIS_HOP_SECONDS = 1 / 60;
export const AUDIO_ANALYSIS_SAMPLE_RATE = 48_000;
export const AUDIO_ANALYSIS_FFT_SIZE = 4_096;
export const AUDIO_ANALYSIS_MIN_FREQUENCY = 30;
export const AUDIO_ANALYSIS_MAX_FREQUENCY = 16_000;
/** Band values map this dBFS floor to 0 and 0 dBFS to 1. */
export const AUDIO_ANALYSIS_FLOOR_DB = -90;
const LOUDNESS_FLOOR_DB = -60;
const LEVEL_WINDOW = 2_048;
const WAVEFORM_WINDOW = 1_024;
const LOW_MID_SPLIT_HZ = 250;
const MID_HIGH_SPLIT_HZ = 4_000;

const HEADER_FLOATS = 16;
const SPECTRUM_OFFSET = HEADER_FLOATS;
const WAVEFORM_OFFSET = SPECTRUM_OFFSET + AUDIO_ANALYSIS_BANDS * AUDIO_ANALYSIS_HISTORY;
export const AUDIO_ANALYSIS_FLOATS = WAVEFORM_OFFSET + AUDIO_ANALYSIS_WAVEFORM;
export const AUDIO_ANALYSIS_BYTES = AUDIO_ANALYSIS_FLOATS * Float32Array.BYTES_PER_ELEMENT;

export const AUDIO_ANALYSIS_FLAG_PRESENT = 1;
export const AUDIO_ANALYSIS_FLAG_PENDING = 2;

/** WGSL declaration of the read-only `aster_audio` buffer granted by `audio_analysis`. */
export const audioAnalysisAbiWgsl = /* wgsl */ `
struct AsterAudioAnalysis {
  info: vec4u,
  timing: vec4f,
  levels: vec4f,
  energy: vec4f,
  spectrum: array<f32, ${AUDIO_ANALYSIS_BANDS * AUDIO_ANALYSIS_HISTORY}>,
  waveform: array<f32, ${AUDIO_ANALYSIS_WAVEFORM}>,
}
`;

/**
 * Reads mono composition audio at the analysis sample rate. Samples outside the composition or
 * outside every audible layer must be zero, so analysis stays time-addressable at any seek.
 */
export type MonoAudioReader = (startSample: number, length: number) => Float32Array;

export interface AudioAnalysisFrameOptions {
  flags?: number;
  /** Shares band vectors between neighbouring frames; keys are absolute sample indices. */
  bandCache?: Map<number, Float32Array>;
}

const BAND_EDGES = buildBandEdges();

/** Packs one `AsterAudioAnalysis` record for `time` from a deterministic mono reader. */
export function buildAudioAnalysisFrame(
  read: MonoAudioReader | undefined,
  time: number,
  options: AudioAnalysisFrameOptions = {},
): Float32Array {
  const output = new Float32Array(AUDIO_ANALYSIS_FLOATS);
  const integers = new Uint32Array(output.buffer);
  const flags = (options.flags ?? 0) | (read ? AUDIO_ANALYSIS_FLAG_PRESENT : 0);
  integers.set([AUDIO_ANALYSIS_BANDS, AUDIO_ANALYSIS_HISTORY, AUDIO_ANALYSIS_WAVEFORM, flags], 0);
  output.set(
    [
      Number.isFinite(time) ? time : 0,
      AUDIO_ANALYSIS_HOP_SECONDS,
      AUDIO_ANALYSIS_MIN_FREQUENCY,
      AUDIO_ANALYSIS_MAX_FREQUENCY,
    ],
    4,
  );
  if (!read || !Number.isFinite(time)) return output;

  const center = Math.round(time * AUDIO_ANALYSIS_SAMPLE_RATE);
  for (let frame = 0; frame < AUDIO_ANALYSIS_HISTORY; frame += 1) {
    const frameCenter =
      center - Math.round(frame * AUDIO_ANALYSIS_HOP_SECONDS * AUDIO_ANALYSIS_SAMPLE_RATE);
    output.set(
      cachedBands(read, frameCenter, options.bandCache),
      SPECTRUM_OFFSET + frame * AUDIO_ANALYSIS_BANDS,
    );
  }

  const level = read(center - LEVEL_WINDOW / 2, LEVEL_WINDOW);
  let squareSum = 0;
  let peak = 0;
  for (const sample of level) {
    squareSum += sample * sample;
    peak = Math.max(peak, Math.abs(sample));
  }
  const rms = Math.sqrt(squareSum / LEVEL_WINDOW);
  const current = output.subarray(SPECTRUM_OFFSET, SPECTRUM_OFFSET + AUDIO_ANALYSIS_BANDS);
  const previous = output.subarray(
    SPECTRUM_OFFSET + AUDIO_ANALYSIS_BANDS,
    SPECTRUM_OFFSET + AUDIO_ANALYSIS_BANDS * 2,
  );
  let flux = 0;
  for (let band = 0; band < AUDIO_ANALYSIS_BANDS; band += 1)
    flux += Math.max(0, current[band] - previous[band]);
  output.set(
    [rms, peak, normalizedDecibels(rms, LOUDNESS_FLOOR_DB), flux / AUDIO_ANALYSIS_BANDS],
    8,
  );
  output.set(
    [
      bandMean(current, 0, LOW_MID_SPLIT_HZ),
      bandMean(current, LOW_MID_SPLIT_HZ, MID_HIGH_SPLIT_HZ),
      bandMean(current, MID_HIGH_SPLIT_HZ, Number.POSITIVE_INFINITY),
      0,
    ],
    12,
  );

  const waveform = read(center - WAVEFORM_WINDOW / 2, WAVEFORM_WINDOW);
  const decimation = WAVEFORM_WINDOW / AUDIO_ANALYSIS_WAVEFORM;
  for (let index = 0; index < AUDIO_ANALYSIS_WAVEFORM; index += 1) {
    let sum = 0;
    for (let offset = 0; offset < decimation; offset += 1)
      sum += waveform[index * decimation + offset];
    output[WAVEFORM_OFFSET + index] = sum / decimation;
  }
  return output;
}

/** Center frequency in Hz of a band index, matching the host's log-spaced layout. */
export function audioAnalysisBandFrequency(band: number): number {
  return (
    AUDIO_ANALYSIS_MIN_FREQUENCY *
    (AUDIO_ANALYSIS_MAX_FREQUENCY / AUDIO_ANALYSIS_MIN_FREQUENCY) **
      ((band + 0.5) / AUDIO_ANALYSIS_BANDS)
  );
}

function cachedBands(
  read: MonoAudioReader,
  centerSample: number,
  cache: Map<number, Float32Array> | undefined,
): Float32Array {
  const cached = cache?.get(centerSample);
  if (cached) return cached;
  const bands = analyzeBands(
    read(centerSample - AUDIO_ANALYSIS_FFT_SIZE / 2, AUDIO_ANALYSIS_FFT_SIZE),
  );
  cache?.set(centerSample, bands);
  return bands;
}

function analyzeBands(samples: Float32Array): Float32Array {
  const spectrum = analyzeSpectrum(samples, AUDIO_ANALYSIS_SAMPLE_RATE, {
    fftSize: AUDIO_ANALYSIS_FFT_SIZE,
    window: "hann",
  });
  const binHz = AUDIO_ANALYSIS_SAMPLE_RATE / AUDIO_ANALYSIS_FFT_SIZE;
  const binCount = spectrum.length / 4;
  const magnitudeAt = (bin: number) => spectrum[Math.min(binCount - 1, Math.max(0, bin)) * 4 + 1];
  const bands = new Float32Array(AUDIO_ANALYSIS_BANDS);
  for (let band = 0; band < AUDIO_ANALYSIS_BANDS; band += 1) {
    const low = BAND_EDGES[band] / binHz;
    const high = BAND_EDGES[band + 1] / binHz;
    // Narrow low bands fall between bins, so interpolate at the center; wide bands keep the
    // strongest contained bin so tonal peaks are not averaged away.
    const centerBin = Math.sqrt(low * high);
    const lower = Math.floor(centerBin);
    let magnitude =
      magnitudeAt(lower) + (magnitudeAt(lower + 1) - magnitudeAt(lower)) * (centerBin - lower);
    for (let bin = Math.ceil(low); bin < high; bin += 1)
      magnitude = Math.max(magnitude, magnitudeAt(bin));
    bands[band] = normalizedDecibels(magnitude, AUDIO_ANALYSIS_FLOOR_DB);
  }
  return bands;
}

function buildBandEdges(): Float64Array {
  const edges = new Float64Array(AUDIO_ANALYSIS_BANDS + 1);
  const ratio = AUDIO_ANALYSIS_MAX_FREQUENCY / AUDIO_ANALYSIS_MIN_FREQUENCY;
  for (let edge = 0; edge <= AUDIO_ANALYSIS_BANDS; edge += 1)
    edges[edge] = AUDIO_ANALYSIS_MIN_FREQUENCY * ratio ** (edge / AUDIO_ANALYSIS_BANDS);
  return edges;
}

function bandMean(bands: Float32Array, minimumHz: number, maximumHz: number): number {
  let sum = 0;
  let count = 0;
  for (let band = 0; band < AUDIO_ANALYSIS_BANDS; band += 1) {
    const frequency = audioAnalysisBandFrequency(band);
    if (frequency < minimumHz || frequency >= maximumHz) continue;
    sum += bands[band];
    count += 1;
  }
  return count > 0 ? sum / count : 0;
}

function normalizedDecibels(magnitude: number, floorDb: number): number {
  if (!(magnitude > 0)) return 0;
  return Math.min(1, Math.max(0, (20 * Math.log10(magnitude) - floorDb) / -floorDb));
}
