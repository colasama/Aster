export const MIN_AUDIO_SAMPLE_RATE = 8_000;
export const MAX_AUDIO_SAMPLE_RATE = 384_000;
export const MIN_AUDIO_PLAYBACK_RATE = 0.01;
export const MAX_AUDIO_PLAYBACK_RATE = 16;

export interface AudioClockOptions {
  sampleRate: number;
  durationSamples: number;
  driftToleranceSeconds?: number;
  hardResyncSeconds?: number;
  correctionWindowSeconds?: number;
  maxCorrectionRate?: number;
}

export interface AudioClockSnapshot {
  /** The interleaved PCM frame at the playhead. */
  sample: number;
  /** Fractional position retained internally so rate changes do not accumulate rounding error. */
  exactSample: number;
  timeSeconds: number;
  playing: boolean;
  ended: boolean;
  playbackRate: number;
  correctionRate: number;
}

export type AudioSyncAction = "none" | "resync" | "slew";

export interface AudioSyncResult {
  action: AudioSyncAction;
  driftSamples: number;
  driftSeconds: number;
  correctionRate: number;
  snapshot: AudioClockSnapshot;
}

interface NormalizedAudioClockOptions {
  sampleRate: number;
  durationSamples: number;
  driftToleranceSeconds: number;
  hardResyncSeconds: number;
  correctionWindowSeconds: number;
  maxCorrectionRate: number;
}

/**
 * A deterministic audio timeline clock. It owns no decoder or output device; callers provide a
 * monotonic host timestamp and use the returned PCM frame to schedule their playback backend.
 */
export class AudioTimelineClock {
  readonly sampleRate: number;
  readonly durationSamples: number;

  private readonly options: NormalizedAudioClockOptions;
  private anchorHostTime = 0;
  private anchorSample = 0;
  private running = false;
  private rate = 1;
  private correctionRate = 0;
  private correctionDuration = 0;

  constructor(options: AudioClockOptions) {
    this.options = normalizeOptions(options);
    this.sampleRate = this.options.sampleRate;
    this.durationSamples = this.options.durationSamples;
  }

  snapshot(hostTime: number): AudioClockSnapshot {
    assertHostTime(hostTime, this.anchorHostTime);
    const exactSample = this.projectSample(hostTime);
    const ended = exactSample >= this.durationSamples;
    return {
      sample: Math.min(this.durationSamples, Math.floor(exactSample + 0.000_000_1)),
      exactSample,
      timeSeconds: exactSample / this.sampleRate,
      playing: this.running && !ended,
      ended,
      playbackRate: this.rate,
      correctionRate: this.activeCorrectionRate(hostTime),
    };
  }

  play(hostTime: number): AudioClockSnapshot {
    this.commit(hostTime);
    this.running = this.anchorSample < this.durationSamples;
    return this.snapshot(hostTime);
  }

  pause(hostTime: number): AudioClockSnapshot {
    this.commit(hostTime);
    this.running = false;
    return this.snapshot(hostTime);
  }

  seekSamples(sample: number, hostTime: number): AudioClockSnapshot {
    assertHostTime(hostTime, this.anchorHostTime);
    if (!Number.isSafeInteger(sample)) throw new RangeError("sample must be a safe integer");
    this.anchorSample = clamp(sample, 0, this.durationSamples);
    this.anchorHostTime = hostTime;
    this.clearCorrection();
    return this.snapshot(hostTime);
  }

  seekSeconds(timeSeconds: number, hostTime: number): AudioClockSnapshot {
    if (!Number.isFinite(timeSeconds)) throw new RangeError("timeSeconds must be finite");
    return this.seekSamples(Math.round(timeSeconds * this.sampleRate), hostTime);
  }

  setPlaybackRate(playbackRate: number, hostTime: number): AudioClockSnapshot {
    assertInRange("playbackRate", playbackRate, MIN_AUDIO_PLAYBACK_RATE, MAX_AUDIO_PLAYBACK_RATE);
    this.commit(hostTime);
    this.rate = playbackRate;
    return this.snapshot(hostTime);
  }

  /** Reconciles this audio clock against an authoritative composition/video time. */
  synchronize(masterTimeSeconds: number, hostTime: number): AudioSyncResult {
    if (!Number.isFinite(masterTimeSeconds)) {
      throw new RangeError("masterTimeSeconds must be finite");
    }
    this.commit(hostTime);
    const targetSample = clamp(
      Math.round(masterTimeSeconds * this.sampleRate),
      0,
      this.durationSamples,
    );
    const driftSamples = targetSample - this.anchorSample;
    const driftSeconds = driftSamples / this.sampleRate;
    const absoluteDrift = Math.abs(driftSeconds);

    let action: AudioSyncAction = "none";
    if (
      absoluteDrift >= this.options.hardResyncSeconds ||
      (!this.running && absoluteDrift > this.options.driftToleranceSeconds)
    ) {
      this.anchorSample = targetSample;
      action = "resync";
    } else if (absoluteDrift > this.options.driftToleranceSeconds) {
      const maximumCorrection = Math.min(this.options.maxCorrectionRate, this.rate);
      this.correctionRate = clamp(
        driftSeconds / this.options.correctionWindowSeconds,
        -maximumCorrection,
        maximumCorrection,
      );
      this.correctionDuration = this.options.correctionWindowSeconds;
      action = "slew";
    }

    return {
      action,
      driftSamples,
      driftSeconds,
      correctionRate: this.correctionRate,
      snapshot: this.snapshot(hostTime),
    };
  }

  private commit(hostTime: number): void {
    assertHostTime(hostTime, this.anchorHostTime);
    this.anchorSample = this.projectSample(hostTime);
    this.anchorHostTime = hostTime;
    this.clearCorrection();
  }

  private projectSample(hostTime: number): number {
    if (!this.running) return this.anchorSample;
    const elapsed = hostTime - this.anchorHostTime;
    const correctedElapsed = Math.min(elapsed, this.correctionDuration);
    const timelineSeconds = elapsed * this.rate + correctedElapsed * this.correctionRate;
    return clamp(this.anchorSample + timelineSeconds * this.sampleRate, 0, this.durationSamples);
  }

  private activeCorrectionRate(hostTime: number): number {
    if (!this.running || hostTime - this.anchorHostTime >= this.correctionDuration) return 0;
    return this.correctionRate;
  }

  private clearCorrection(): void {
    this.correctionRate = 0;
    this.correctionDuration = 0;
  }
}

function normalizeOptions(options: AudioClockOptions): NormalizedAudioClockOptions {
  assertIntegerInRange(
    "sampleRate",
    options.sampleRate,
    MIN_AUDIO_SAMPLE_RATE,
    MAX_AUDIO_SAMPLE_RATE,
  );
  assertIntegerInRange("durationSamples", options.durationSamples, 0, Number.MAX_SAFE_INTEGER);
  const driftToleranceSeconds = options.driftToleranceSeconds ?? 0.005;
  const hardResyncSeconds = options.hardResyncSeconds ?? 0.25;
  const correctionWindowSeconds = options.correctionWindowSeconds ?? 0.5;
  const maxCorrectionRate = options.maxCorrectionRate ?? 0.05;
  assertInRange("driftToleranceSeconds", driftToleranceSeconds, 0, 1);
  assertInRange("hardResyncSeconds", hardResyncSeconds, Number.EPSILON, 60);
  assertInRange("correctionWindowSeconds", correctionWindowSeconds, 0.01, 60);
  assertInRange("maxCorrectionRate", maxCorrectionRate, Number.EPSILON, 1);
  if (hardResyncSeconds <= driftToleranceSeconds) {
    throw new RangeError("hardResyncSeconds must exceed driftToleranceSeconds");
  }
  return {
    sampleRate: options.sampleRate,
    durationSamples: options.durationSamples,
    driftToleranceSeconds,
    hardResyncSeconds,
    correctionWindowSeconds,
    maxCorrectionRate,
  };
}

function assertHostTime(hostTime: number, minimum: number): void {
  if (!Number.isFinite(hostTime) || hostTime < minimum) {
    throw new RangeError("hostTime must be finite and monotonic");
  }
}

function assertIntegerInRange(name: string, value: number, minimum: number, maximum: number): void {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
}

function assertInRange(name: string, value: number, minimum: number, maximum: number): void {
  if (!Number.isFinite(value) || value < minimum || value > maximum) {
    throw new RangeError(`${name} must be between ${minimum} and ${maximum}`);
  }
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}
