/**
 * Offline tempo, beat-grid and section analysis for music PCM. Pure and DOM-free, so the renderer
 * (project sources) and the Electron host (reference files decoded by FFmpeg) share it.
 */

export interface BeatAnalysis {
  bpm: number;
  /** Time of the first beat of the grid; beat n falls at offset + n * 60 / bpm. */
  offset: number;
  /** 0..1; how strongly the onset envelope repeats at the chosen period. */
  confidence: number;
  beats: number[];
  downbeats: number[];
  /** Beat index (0..3) of downbeats within each bar. */
  downbeatPhase: number;
  sections: Array<{ start: number; end: number; energy: number }>;
  duration: number;
}

export interface BeatAnalysisOptions {
  minBpm?: number;
  maxBpm?: number;
  beatsPerBar?: number;
  /** Shortest section to report, in seconds. */
  minSectionSeconds?: number;
}

const ANALYSIS_RATE = 11_025;
const FRAME_RATE = 100;
const FFT_SIZE = 512;
/**
 * Frames are stamped at their window start, but Hann-weighted flux peaks once an onset sits about
 * 69% into the 46 ms window. Calibrated against synthetic clicks at 90-152 BPM.
 */
const ONSET_LATENCY_SECONDS = 0.032;

export function analyzeBeats(
  samples: Float32Array,
  sampleRate: number,
  options: BeatAnalysisOptions = {},
): BeatAnalysis {
  if (!(sampleRate > 0) || samples.length < sampleRate)
    throw new Error("Beat analysis needs at least one second of audio");
  const minBpm = options.minBpm ?? 60;
  const maxBpm = options.maxBpm ?? 200;
  if (!(minBpm > 0 && maxBpm > minBpm)) throw new Error("Invalid BPM range");
  const beatsPerBar = Math.max(1, Math.round(options.beatsPerBar ?? 4));
  const audio = resample(samples, sampleRate, ANALYSIS_RATE);
  const duration = samples.length / sampleRate;
  const { onset, bass, energy } = onsetEnvelopes(audio);
  const period = estimatePeriod(onset, minBpm, maxBpm);
  const phase = bestPhase(onset, period.frames);
  const beatFrames: number[] = [];
  for (let frame = phase; frame < onset.length; frame += period.frames) beatFrames.push(frame);
  const beats = beatFrames.map((frame) => round(frame / FRAME_RATE + ONSET_LATENCY_SECONDS));
  const downbeatPhase = bestDownbeatPhase(bass, onset, beatFrames, beatsPerBar);
  const downbeats = beats.filter((_, index) => index % beatsPerBar === downbeatPhase);
  const bpm = (60 * FRAME_RATE) / period.frames;
  return {
    bpm: round(bpm, 2),
    offset: beats[0] ?? 0,
    confidence: round(period.confidence, 3),
    beats,
    downbeats,
    downbeatPhase,
    sections: detectSections(energy, downbeats, duration, options.minSectionSeconds ?? 8),
    duration: round(duration),
  };
}

/** Averaging decimation, adequate for onset detection below 5 kHz. */
function resample(samples: Float32Array, from: number, to: number): Float32Array {
  if (from <= to) return samples;
  const ratio = from / to;
  const length = Math.floor(samples.length / ratio);
  const output = new Float32Array(length);
  for (let index = 0; index < length; index++) {
    const start = Math.floor(index * ratio);
    const end = Math.min(samples.length, Math.floor((index + 1) * ratio));
    let sum = 0;
    for (let cursor = start; cursor < end; cursor++) sum += samples[cursor];
    output[index] = sum / Math.max(1, end - start);
  }
  return output;
}

/** Log-magnitude spectral flux (full band and bass band) plus RMS energy, at 100 frames/s. */
function onsetEnvelopes(audio: Float32Array) {
  const hop = ANALYSIS_RATE / FRAME_RATE;
  const frames = Math.max(1, Math.floor((audio.length - FFT_SIZE) / hop) + 1);
  const window = new Float32Array(FFT_SIZE).map(
    (_, index) => 0.5 - 0.5 * Math.cos((2 * Math.PI * index) / (FFT_SIZE - 1)),
  );
  const bassBins = Math.round((200 / ANALYSIS_RATE) * FFT_SIZE);
  const real = new Float64Array(FFT_SIZE);
  const imaginary = new Float64Array(FFT_SIZE);
  let previous = new Float64Array(FFT_SIZE / 2);
  let current = new Float64Array(FFT_SIZE / 2);
  const onset = new Float32Array(frames);
  const bass = new Float32Array(frames);
  const energy = new Float32Array(frames);
  for (let frame = 0; frame < frames; frame++) {
    const start = Math.round(frame * hop);
    let sumSquares = 0;
    for (let index = 0; index < FFT_SIZE; index++) {
      const sample = audio[start + index] ?? 0;
      sumSquares += sample * sample;
      real[index] = sample * window[index];
      imaginary[index] = 0;
    }
    fft(real, imaginary);
    let flux = 0;
    let bassFlux = 0;
    for (let bin = 1; bin < FFT_SIZE / 2; bin++) {
      const magnitude = Math.log1p(10 * Math.hypot(real[bin], imaginary[bin]));
      current[bin] = magnitude;
      const rise = Math.max(0, magnitude - previous[bin]);
      flux += rise;
      if (bin <= bassBins) bassFlux += rise;
    }
    onset[frame] = flux;
    bass[frame] = bassFlux;
    energy[frame] = Math.sqrt(sumSquares / FFT_SIZE);
    [previous, current] = [current, previous];
  }
  return { onset: normalize(highPass(onset)), bass: normalize(highPass(bass)), energy };
}

/** Removes the slowly varying loudness trend so only onsets remain. */
function highPass(values: Float32Array): Float32Array {
  const radius = FRAME_RATE / 4;
  const output = new Float32Array(values.length);
  let sum = 0;
  let count = 0;
  for (let index = 0; index < values.length + radius; index++) {
    if (index < values.length) {
      sum += values[index];
      count++;
    }
    if (index - 2 * radius - 1 >= 0) {
      sum -= values[index - 2 * radius - 1];
      count--;
    }
    const center = index - radius;
    if (center >= 0 && center < values.length)
      output[center] = Math.max(0, values[center] - sum / count);
  }
  return output;
}

function normalize(values: Float32Array): Float32Array {
  let maximum = 0;
  for (const value of values) maximum = Math.max(maximum, value);
  if (maximum <= 0) return values;
  return values.map((value) => value / maximum);
}

/** Autocorrelation tempo with a log-normal prior around 120 BPM to avoid octave errors. */
function estimatePeriod(onset: Float32Array, minBpm: number, maxBpm: number) {
  const minLag = Math.floor((60 * FRAME_RATE) / maxBpm);
  const maxLag = Math.ceil((60 * FRAME_RATE) / minBpm);
  const scores = new Float64Array(maxLag + 2);
  let zeroLag = 0;
  for (const value of onset) zeroLag += value * value;
  for (let lag = minLag; lag <= maxLag + 1; lag++) {
    let sum = 0;
    for (let index = lag; index < onset.length; index++) sum += onset[index] * onset[index - lag];
    scores[lag] = sum / Math.max(1, onset.length - lag);
  }
  let bestLag = minLag;
  let bestScore = -Infinity;
  for (let lag = minLag; lag <= maxLag; lag++) {
    const bpm = (60 * FRAME_RATE) / lag;
    const prior = Math.exp(-0.5 * (Math.log2(bpm / 120) / 0.9) ** 2);
    const weighted = scores[lag] * prior;
    if (weighted > bestScore) {
      bestScore = weighted;
      bestLag = lag;
    }
  }
  // Parabolic refinement gives sub-frame period precision.
  const left = scores[bestLag - 1] ?? scores[bestLag];
  const right = scores[bestLag + 1] ?? scores[bestLag];
  const denominator = left - 2 * scores[bestLag] + right;
  const shift =
    denominator === 0 ? 0 : Math.max(-0.5, Math.min(0.5, (left - right) / (2 * denominator)));
  const frames = refinePeriod(onset, bestLag + shift);
  const mean = zeroLag / Math.max(1, onset.length);
  const confidence = mean > 0 ? Math.min(1, scores[bestLag] / mean) : 0;
  return { frames, confidence };
}

/** Maximizes grid alignment over the whole track to remove residual drift in long songs. */
function refinePeriod(onset: Float32Array, estimate: number): number {
  let best = estimate;
  let bestScore = -Infinity;
  for (let candidate = estimate - 1; candidate <= estimate + 1; candidate += 0.01) {
    const phase = bestPhase(onset, candidate);
    const score = gridScore(onset, candidate, phase);
    if (score > bestScore) {
      bestScore = score;
      best = candidate;
    }
  }
  return best;
}

function bestPhase(onset: Float32Array, period: number): number {
  let best = 0;
  let bestScore = -Infinity;
  for (let phase = 0; phase < period; phase += 0.5) {
    const score = gridScore(onset, period, phase);
    if (score > bestScore) {
      bestScore = score;
      best = phase;
    }
  }
  return best;
}

function gridScore(onset: Float32Array, period: number, phase: number): number {
  let score = 0;
  for (let frame = phase; frame < onset.length; frame += period) {
    const index = Math.floor(frame);
    const fraction = frame - index;
    score += (onset[index] ?? 0) * (1 - fraction) + (onset[index + 1] ?? 0) * fraction;
  }
  return score;
}

/** Downbeats carry the strongest bass onsets; pick the bar phase with the most bass energy. */
function bestDownbeatPhase(
  bass: Float32Array,
  onset: Float32Array,
  beatFrames: readonly number[],
  beatsPerBar: number,
): number {
  const totals = new Float64Array(beatsPerBar);
  for (const [index, beatFrame] of beatFrames.entries()) {
    const frame = Math.round(beatFrame);
    let peak = 0;
    for (let cursor = frame - 3; cursor <= frame + 3; cursor++)
      peak = Math.max(peak, 2 * (bass[cursor] ?? 0) + (onset[cursor] ?? 0));
    totals[index % beatsPerBar] += peak;
  }
  let best = 0;
  for (let phase = 1; phase < beatsPerBar; phase++) if (totals[phase] > totals[best]) best = phase;
  return best;
}

/** Splits at large changes of smoothed loudness, snapped to downbeats. */
function detectSections(
  energy: Float32Array,
  downbeats: readonly number[],
  duration: number,
  minimumSeconds: number,
): BeatAnalysis["sections"] {
  const window = FRAME_RATE * 2;
  const smoothed = new Float32Array(energy.length);
  let sum = 0;
  for (let index = 0; index < energy.length; index++) {
    sum += energy[index];
    if (index >= window) sum -= energy[index - window];
    smoothed[index] = sum / Math.min(index + 1, window);
  }
  let peak = 1e-9;
  for (const value of smoothed) peak = Math.max(peak, value);
  const lag = FRAME_RATE * 4;
  const novelty: Array<{ frame: number; value: number }> = [];
  for (let index = lag; index < smoothed.length - lag; index++)
    novelty.push({
      frame: index,
      value: Math.abs(smoothed[index + lag] - smoothed[index - lag]) / peak,
    });
  const boundaries: number[] = [];
  for (const candidate of novelty.sort((left, right) => right.value - left.value)) {
    if (candidate.value < 0.2) break;
    const time = candidate.frame / FRAME_RATE;
    if (boundaries.every((boundary) => Math.abs(boundary - time) >= minimumSeconds))
      boundaries.push(time);
  }
  const snapped = [
    ...new Set(
      boundaries
        .map((time) =>
          downbeats.length
            ? downbeats.reduce((best, beat) =>
                Math.abs(beat - time) < Math.abs(best - time) ? beat : best,
              )
            : time,
        )
        .filter((time) => time >= minimumSeconds / 2 && duration - time >= minimumSeconds / 2),
    ),
  ].sort((left, right) => left - right);
  const edges = [0, ...snapped, duration];
  return edges.slice(0, -1).map((start, index) => {
    const end = edges[index + 1];
    let total = 0;
    let count = 0;
    for (
      let frame = Math.floor(start * FRAME_RATE);
      frame < Math.min(smoothed.length, end * FRAME_RATE);
      frame++
    ) {
      total += smoothed[frame];
      count++;
    }
    return {
      start: round(start),
      end: round(end),
      energy: round(total / Math.max(1, count) / peak, 3),
    };
  });
}

/** In-place iterative radix-2 FFT. */
function fft(real: Float64Array, imaginary: Float64Array): void {
  const size = real.length;
  for (let index = 1, reversed = 0; index < size; index++) {
    let bit = size >> 1;
    for (; reversed & bit; bit >>= 1) reversed ^= bit;
    reversed ^= bit;
    if (index < reversed) {
      [real[index], real[reversed]] = [real[reversed], real[index]];
      [imaginary[index], imaginary[reversed]] = [imaginary[reversed], imaginary[index]];
    }
  }
  for (let length = 2; length <= size; length <<= 1) {
    const angle = (-2 * Math.PI) / length;
    const stepReal = Math.cos(angle);
    const stepImaginary = Math.sin(angle);
    for (let start = 0; start < size; start += length) {
      let twiddleReal = 1;
      let twiddleImaginary = 0;
      for (let offset = 0; offset < length / 2; offset++) {
        const even = start + offset;
        const odd = even + length / 2;
        const oddReal = real[odd] * twiddleReal - imaginary[odd] * twiddleImaginary;
        const oddImaginary = real[odd] * twiddleImaginary + imaginary[odd] * twiddleReal;
        real[odd] = real[even] - oddReal;
        imaginary[odd] = imaginary[even] - oddImaginary;
        real[even] += oddReal;
        imaginary[even] += oddImaginary;
        [twiddleReal, twiddleImaginary] = [
          twiddleReal * stepReal - twiddleImaginary * stepImaginary,
          twiddleReal * stepImaginary + twiddleImaginary * stepReal,
        ];
      }
    }
  }
}

function round(value: number, digits = 4): number {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}
