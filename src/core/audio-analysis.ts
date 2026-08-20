export const MAX_WAVEFORM_BINS = 65_536;
export const MAX_FFT_SIZE = 32_768;

export type SpectrumWindow = "blackman" | "hamming" | "hann" | "rectangular";

export interface SpectrumOptions {
  fftSize?: number;
  startSample?: number;
  window?: SpectrumWindow;
}

export interface AudioVolumeState {
  gain: number;
  muted: boolean;
}

export const DEFAULT_AUDIO_VOLUME: Readonly<AudioVolumeState> = Object.freeze({
  gain: 1,
  muted: false,
});

/**
 * Reduces mono PCM to GPU-friendly vec4 records: min, max, RMS, and covered sample count.
 */
export function buildWaveformPeaks(samples: Float32Array, binCount: number): Float32Array {
  assertIntegerInRange("binCount", binCount, 1, MAX_WAVEFORM_BINS);
  const peaks = new Float32Array(binCount * 4);
  for (let bin = 0; bin < binCount; bin += 1) {
    const start = Math.floor((bin * samples.length) / binCount);
    const end = Math.floor(((bin + 1) * samples.length) / binCount);
    if (end <= start) continue;

    let minimum = Number.POSITIVE_INFINITY;
    let maximum = Number.NEGATIVE_INFINITY;
    let squareSum = 0;
    for (let index = start; index < end; index += 1) {
      const sample = finiteSample(samples[index]);
      minimum = Math.min(minimum, sample);
      maximum = Math.max(maximum, sample);
      squareSum += sample * sample;
    }
    const offset = bin * 4;
    peaks[offset] = minimum;
    peaks[offset + 1] = maximum;
    peaks[offset + 2] = Math.sqrt(squareSum / (end - start));
    peaks[offset + 3] = end - start;
  }
  return peaks;
}

/**
 * Computes a radix-2 FFT and returns vec4 records: frequency Hz, magnitude, power, phase.
 */
export function analyzeSpectrum(
  samples: Float32Array,
  sampleRate: number,
  options: SpectrumOptions = {},
): Float32Array {
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) {
    throw new RangeError("sampleRate must be a positive finite number");
  }
  const fftSize = options.fftSize ?? 2_048;
  assertFftSize(fftSize);
  const startSample = options.startSample ?? 0;
  assertIntegerInRange("startSample", startSample, 0, Number.MAX_SAFE_INTEGER);
  const windowName = options.window ?? "hann";
  const real = new Float64Array(fftSize);
  const imaginary = new Float64Array(fftSize);
  let coherentGain = 0;
  for (let index = 0; index < fftSize; index += 1) {
    const weight = windowCoefficient(windowName, index, fftSize);
    coherentGain += weight;
    const sourceIndex = startSample + index;
    real[index] = (sourceIndex < samples.length ? finiteSample(samples[sourceIndex]) : 0) * weight;
  }

  fftInPlace(real, imaginary);
  const binCount = fftSize / 2 + 1;
  const spectrum = new Float32Array(binCount * 4);
  const normalization = coherentGain > Number.EPSILON ? 1 / coherentGain : 1 / fftSize;
  for (let bin = 0; bin < binCount; bin += 1) {
    const edgeScale = bin === 0 || bin === fftSize / 2 ? normalization : normalization * 2;
    const magnitude = Math.hypot(real[bin], imaginary[bin]) * edgeScale;
    const offset = bin * 4;
    spectrum[offset] = (bin * sampleRate) / fftSize;
    spectrum[offset + 1] = magnitude;
    spectrum[offset + 2] = magnitude * magnitude;
    spectrum[offset + 3] = Math.atan2(imaginary[bin], real[bin]);
  }
  return spectrum;
}

export function normalizeAudioVolume(volume: AudioVolumeState): AudioVolumeState {
  return {
    gain: Number.isFinite(volume.gain) ? Math.max(0, Math.min(4, volume.gain)) : 1,
    muted: volume.muted,
  };
}

export function effectiveAudioGain(volume: AudioVolumeState): number {
  const normalized = normalizeAudioVolume(volume);
  return normalized.muted ? 0 : normalized.gain;
}

/** Applies volume without mutating the source PCM. */
export function applyAudioVolume(samples: Float32Array, volume: AudioVolumeState): Float32Array {
  const output = new Float32Array(samples.length);
  const gain = effectiveAudioGain(volume);
  if (gain === 0) return output;
  for (let index = 0; index < samples.length; index += 1) {
    output[index] = finiteSample(samples[index]) * gain;
  }
  return output;
}

export function gainToDecibels(gain: number): number {
  return gain > 0 && Number.isFinite(gain) ? 20 * Math.log10(gain) : Number.NEGATIVE_INFINITY;
}

export function decibelsToGain(decibels: number): number {
  if (decibels === Number.NEGATIVE_INFINITY) return 0;
  if (!Number.isFinite(decibels)) throw new RangeError("decibels must be finite or -Infinity");
  return 10 ** (decibels / 20);
}

function fftInPlace(real: Float64Array, imaginary: Float64Array): void {
  const size = real.length;
  for (let index = 1, reversed = 0; index < size; index += 1) {
    let bit = size >> 1;
    while ((reversed & bit) !== 0) {
      reversed ^= bit;
      bit >>= 1;
    }
    reversed ^= bit;
    if (index < reversed) {
      [real[index], real[reversed]] = [real[reversed], real[index]];
      [imaginary[index], imaginary[reversed]] = [imaginary[reversed], imaginary[index]];
    }
  }

  for (let length = 2; length <= size; length *= 2) {
    const angle = (-2 * Math.PI) / length;
    const stepReal = Math.cos(angle);
    const stepImaginary = Math.sin(angle);
    for (let offset = 0; offset < size; offset += length) {
      let twiddleReal = 1;
      let twiddleImaginary = 0;
      const half = length / 2;
      for (let index = 0; index < half; index += 1) {
        const even = offset + index;
        const odd = even + half;
        const oddReal = real[odd] * twiddleReal - imaginary[odd] * twiddleImaginary;
        const oddImaginary = real[odd] * twiddleImaginary + imaginary[odd] * twiddleReal;
        real[odd] = real[even] - oddReal;
        imaginary[odd] = imaginary[even] - oddImaginary;
        real[even] += oddReal;
        imaginary[even] += oddImaginary;
        const nextReal = twiddleReal * stepReal - twiddleImaginary * stepImaginary;
        twiddleImaginary = twiddleReal * stepImaginary + twiddleImaginary * stepReal;
        twiddleReal = nextReal;
      }
    }
  }
}

function windowCoefficient(window: SpectrumWindow, index: number, size: number): number {
  if (window === "rectangular" || size === 1) return 1;
  const phase = (2 * Math.PI * index) / (size - 1);
  if (window === "hann") return 0.5 - 0.5 * Math.cos(phase);
  if (window === "hamming") return 0.54 - 0.46 * Math.cos(phase);
  return 0.42 - 0.5 * Math.cos(phase) + 0.08 * Math.cos(phase * 2);
}

function finiteSample(sample: number): number {
  return Number.isFinite(sample) ? sample : 0;
}

function assertFftSize(size: number): void {
  assertIntegerInRange("fftSize", size, 2, MAX_FFT_SIZE);
  if ((size & (size - 1)) !== 0) throw new RangeError("fftSize must be a power of two");
}

function assertIntegerInRange(name: string, value: number, minimum: number, maximum: number): void {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
}
