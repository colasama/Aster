import { logger } from "../logger";
import type { Composition, FootageSource, Id, Project } from "../types";
import {
  AUDIO_ANALYSIS_FLAG_PENDING,
  AUDIO_ANALYSIS_SAMPLE_RATE,
  buildAudioAnalysisFrame,
  type MonoAudioReader,
} from "./audio-analysis-frame";
import { sharedAudioDecodeCache } from "./audio-decode-cache";
import type { AudioSourceDecoder } from "./audio-export";
import { audibleCompositionLayers, type DecodedPcm, mixCompositionAudio } from "./audio-mixer";

const MAX_CACHED_BANDS = 512;
const DEFAULT_WAIT_MS = 10_000;

type AudioFootageSource = Extract<FootageSource, { kind: "audio" | "video" }>;

interface DecodeEntry {
  promise: Promise<void>;
  pcm?: DecodedPcm;
  failed?: boolean;
}

interface BandCacheEntry {
  project: Project;
  decodedKey: string;
  bands: Map<number, Float32Array>;
}

/**
 * Supplies the scene-generator `aster_audio` record for the audio a viewer hears: the audible
 * layers of the rendered root composition at the root time. Decoding is asynchronous; until it
 * settles the record is flagged pending and the provider acts as an exact-frame barrier so
 * exports recapture the frame with real analysis.
 */
export class AudioAnalysisProvider {
  readonly #decode: AudioSourceDecoder;
  readonly #onReady: () => void;
  readonly #decoded = new Map<string, DecodeEntry>();
  readonly #pending = new Set<Promise<void>>();
  readonly #bandCaches = new WeakMap<Composition, BandCacheEntry>();

  constructor(onReady: () => void = () => undefined, decode: AudioSourceDecoder = decodeShared) {
    this.#decode = decode;
    this.#onReady = onReady;
  }

  frame(project: Project | undefined, composition: Composition, time: number): Float32Array {
    const sources = project ? audibleSources(project, composition) : [];
    if (sources.length === 0) return buildAudioAnalysisFrame(undefined, time);
    const decoded = new Map<Id, DecodedPcm>();
    let pending = false;
    for (const source of sources) {
      const entry = this.#entry(source);
      if (entry.pcm) decoded.set(source.id, entry.pcm);
      else if (!entry.failed) pending = true;
    }
    const read = monoReader(project as Project, composition, decoded);
    return buildAudioAnalysisFrame(read, time, {
      flags: pending ? AUDIO_ANALYSIS_FLAG_PENDING : 0,
      // Silence substituted for still-decoding sources must never be cached as analysis.
      bandCache: pending ? undefined : this.#bandCache(project as Project, composition, decoded),
    });
  }

  get hasPendingFrameResources(): boolean {
    return this.#pending.size > 0;
  }

  async waitForFrameResources(timeoutMs = DEFAULT_WAIT_MS): Promise<void> {
    const started = performance.now();
    while (this.#pending.size > 0) {
      const remaining = timeoutMs - (performance.now() - started);
      if (remaining <= 0) throw new Error("Timed out waiting for audio analysis sources");
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          Promise.all([...this.#pending]),
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(new Error("Timed out waiting for audio analysis sources")),
              remaining,
            );
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    }
  }

  #entry(source: AudioFootageSource): DecodeEntry {
    const existing = this.#decoded.get(source.contentIdentity);
    if (existing) return existing;
    const entry: DecodeEntry = { promise: Promise.resolve() };
    entry.promise = this.#decode(source).then(
      (pcm) => {
        entry.pcm = pcm;
      },
      (error: unknown) => {
        entry.failed = true;
        logger.warn("audio", "audio_analysis_decode_failed", { sourceId: source.id }, error);
      },
    );
    const settled = entry.promise.finally(() => {
      this.#pending.delete(settled);
      this.#onReady();
    });
    this.#pending.add(settled);
    this.#decoded.set(source.contentIdentity, entry);
    return entry;
  }

  #bandCache(
    project: Project,
    composition: Composition,
    decoded: ReadonlyMap<Id, DecodedPcm>,
  ): Map<number, Float32Array> {
    const decodedKey = [...decoded.keys()].sort().join("\u0000");
    let entry = this.#bandCaches.get(composition);
    if (!entry || entry.project !== project || entry.decodedKey !== decodedKey) {
      entry = { project, decodedKey, bands: new Map() };
      this.#bandCaches.set(composition, entry);
    }
    while (entry.bands.size > MAX_CACHED_BANDS) {
      const oldest = entry.bands.keys().next().value;
      if (oldest === undefined) break;
      entry.bands.delete(oldest);
    }
    return entry.bands;
  }
}

function audibleSources(project: Project, composition: Composition): AudioFootageSource[] {
  const sourceById = new Map(project.sources.map((source) => [source.id, source]));
  const sources = new Map<Id, AudioFootageSource>();
  for (const layer of audibleCompositionLayers(composition)) {
    const source = layer.sourceId ? sourceById.get(layer.sourceId) : undefined;
    if (!source || (source.kind !== "audio" && source.kind !== "video")) continue;
    if (source.kind === "video" && !source.audio) continue;
    sources.set(source.id, source);
  }
  return [...sources.values()];
}

function monoReader(
  project: Project,
  composition: Composition,
  decoded: ReadonlyMap<Id, DecodedPcm>,
): MonoAudioReader {
  const durationSamples = Math.floor(composition.duration * AUDIO_ANALYSIS_SAMPLE_RATE);
  return (startSample, length) => {
    const output = new Float32Array(length);
    const first = Math.max(0, startSample);
    const last = Math.min(durationSamples, startSample + length);
    if (decoded.size === 0 || last <= first) return output;
    const mixed = mixCompositionAudio(project, composition, decoded, {
      startTime: first / AUDIO_ANALYSIS_SAMPLE_RATE,
      endTime: last / AUDIO_ANALYSIS_SAMPLE_RATE,
      sampleRate: AUDIO_ANALYSIS_SAMPLE_RATE,
      clipProtection: "none",
    });
    const frames = Math.min(mixed.frameCount, last - first);
    for (let frame = 0; frame < frames; frame += 1)
      output[first - startSample + frame] =
        (mixed.samples[frame * 2] + mixed.samples[frame * 2 + 1]) * 0.5;
    return output;
  };
}

let decodeContext: OfflineAudioContext | undefined;

async function decodeShared(source: AudioFootageSource): Promise<DecodedPcm> {
  decodeContext ??= new OfflineAudioContext(2, 1, AUDIO_ANALYSIS_SAMPLE_RATE);
  const buffer = await sharedAudioDecodeCache.decode(decodeContext, source);
  return {
    sampleRate: buffer.sampleRate,
    channels: Array.from({ length: buffer.numberOfChannels }, (_, channel) =>
      buffer.getChannelData(channel),
    ),
  };
}
