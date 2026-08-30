import { MAX_WAVEFORM_BINS } from "./audio-analysis";
import { runCpuTask } from "./cpu-scheduler";
import { sourceLocator } from "./footage-source";
import type { FootageSource } from "./types";

export const DEFAULT_DECODE_CACHE_BYTES = 256 * 1024 * 1024;
export const DEFAULT_PEAK_CACHE_BYTES = 16 * 1024 * 1024;
const MAX_DECODE_ENTRIES = 32;
const MAX_PEAK_ENTRIES = 64;

interface DecodedEntry {
  buffer: AudioBuffer;
  bytes: number;
}

interface PeakEntry {
  peaks: Float32Array;
  bytes: number;
}

export interface AudioDecodeCacheStatistics {
  decodedEntries: number;
  decodedBytes: number;
  peakEntries: number;
  peakBytes: number;
  pending: number;
}

export class AudioDecodeCache {
  readonly #decoded = new Map<string, DecodedEntry>();
  readonly #pending = new Map<string, Promise<AudioBuffer>>();
  readonly #peaks = new Map<string, PeakEntry>();
  readonly #decodeBudget: number;
  readonly #peakBudget: number;
  #decodedBytes = 0;
  #peakBytes = 0;

  constructor(decodeBudget = DEFAULT_DECODE_CACHE_BYTES, peakBudget = DEFAULT_PEAK_CACHE_BYTES) {
    if (!Number.isSafeInteger(decodeBudget) || decodeBudget < 1)
      throw new RangeError("Audio decode cache budget must be a positive integer");
    if (!Number.isSafeInteger(peakBudget) || peakBudget < 1)
      throw new RangeError("Waveform peak cache budget must be a positive integer");
    this.#decodeBudget = decodeBudget;
    this.#peakBudget = peakBudget;
  }

  async decode(
    context: BaseAudioContext,
    source: FootageSource,
    signal?: AbortSignal,
  ): Promise<AudioBuffer> {
    if (source.kind !== "audio" && source.kind !== "video")
      throw new Error(`${source.kind} footage does not contain playable audio`);
    const cached = this.#decoded.get(source.contentIdentity);
    if (cached) {
      this.#decoded.delete(source.contentIdentity);
      this.#decoded.set(source.contentIdentity, cached);
      return cached.buffer;
    }
    const pending = this.#pending.get(source.contentIdentity);
    if (pending) return pending;
    const decode = this.#decodeSource(context, source, signal);
    this.#pending.set(source.contentIdentity, decode);
    try {
      const buffer = await decode;
      const bytes = buffer.length * buffer.numberOfChannels * Float32Array.BYTES_PER_ELEMENT;
      if (bytes > this.#decodeBudget)
        throw new Error("Decoded audio exceeds the configured cache budget");
      this.#evictDecoded(bytes);
      this.#decoded.set(source.contentIdentity, { buffer, bytes });
      this.#decodedBytes += bytes;
      return buffer;
    } finally {
      this.#pending.delete(source.contentIdentity);
    }
  }

  async waveformPeaks(
    context: BaseAudioContext,
    source: FootageSource,
    binCount: number,
    signal?: AbortSignal,
  ): Promise<Float32Array> {
    if (!Number.isSafeInteger(binCount) || binCount < 1 || binCount > MAX_WAVEFORM_BINS)
      throw new RangeError(`Waveform bin count must be within 1..=${MAX_WAVEFORM_BINS}`);
    const key = `${source.contentIdentity}:${binCount}`;
    const cached = this.#peaks.get(key);
    if (cached) {
      this.#peaks.delete(key);
      this.#peaks.set(key, cached);
      return cached.peaks;
    }
    const buffer = await this.decode(context, source, signal);
    const mono = new Float32Array(buffer.length);
    for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) {
      const samples = buffer.getChannelData(channel);
      for (let index = 0; index < samples.length; index += 1)
        if (Math.abs(samples[index]) > Math.abs(mono[index])) mono[index] = samples[index];
    }
    const peaks = await runCpuTask(
      { kind: "waveform-peaks", samples: mono, binCount },
      { priority: "interactive", signal, transfer: [mono.buffer] },
    );
    const bytes = peaks.byteLength;
    if (bytes <= this.#peakBudget) {
      this.#evictPeaks(bytes);
      this.#peaks.set(key, { peaks, bytes });
      this.#peakBytes += bytes;
    }
    return peaks;
  }

  invalidate(contentIdentity: string): void {
    const decoded = this.#decoded.get(contentIdentity);
    if (decoded) this.#decodedBytes -= decoded.bytes;
    this.#decoded.delete(contentIdentity);
    for (const [key, entry] of this.#peaks)
      if (key.startsWith(`${contentIdentity}:`)) {
        this.#peaks.delete(key);
        this.#peakBytes -= entry.bytes;
      }
  }

  clear(): void {
    this.#decoded.clear();
    this.#peaks.clear();
    this.#decodedBytes = 0;
    this.#peakBytes = 0;
  }

  statistics(): AudioDecodeCacheStatistics {
    return {
      decodedEntries: this.#decoded.size,
      decodedBytes: this.#decodedBytes,
      peakEntries: this.#peaks.size,
      peakBytes: this.#peakBytes,
      pending: this.#pending.size,
    };
  }

  async #decodeSource(
    context: BaseAudioContext,
    source: FootageSource,
    signal?: AbortSignal,
  ): Promise<AudioBuffer> {
    const locator = sourceLocator(source);
    if (!locator)
      throw new Error(`Audio source ${source.name} is offline; relink it before playback`);
    const response = await fetch(locator, { signal });
    if (!response.ok) throw new Error(`Unable to read audio source ${source.name}`);
    const encoded = await response.arrayBuffer();
    if (signal?.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
    const buffer = await context.decodeAudioData(encoded);
    if (
      !Number.isFinite(buffer.duration) ||
      buffer.duration <= 0 ||
      buffer.duration > 86_400 ||
      buffer.numberOfChannels < 1 ||
      buffer.numberOfChannels > 32 ||
      buffer.sampleRate < 8_000 ||
      buffer.sampleRate > 384_000
    )
      throw new Error(`Decoded audio metadata for ${source.name} exceeds supported bounds`);
    return buffer;
  }

  #evictDecoded(incoming: number): void {
    while (
      this.#decoded.size >= MAX_DECODE_ENTRIES ||
      this.#decodedBytes + incoming > this.#decodeBudget
    ) {
      const oldest = this.#decoded.entries().next().value;
      if (!oldest) break;
      this.#decoded.delete(oldest[0]);
      this.#decodedBytes -= oldest[1].bytes;
    }
  }

  #evictPeaks(incoming: number): void {
    while (this.#peaks.size >= MAX_PEAK_ENTRIES || this.#peakBytes + incoming > this.#peakBudget) {
      const oldest = this.#peaks.entries().next().value;
      if (!oldest) break;
      this.#peaks.delete(oldest[0]);
      this.#peakBytes -= oldest[1].bytes;
    }
  }
}

export const sharedAudioDecodeCache = new AudioDecodeCache();
