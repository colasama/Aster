import { evaluateLayerSourceTime } from "../animation/layer-time";
import { logger } from "../logger";
import { sourceForLayer } from "../media/footage-source";
import type { Composition, FootageSource, Layer, Project } from "../types";
import { type AudioDecodeCache, sharedAudioDecodeCache } from "./audio-decode-cache";
import { decibelsToLinear } from "./audio-layer";
import { audibleCompositionLayers, type DecodedPcm } from "./audio-mixer";

type AudioFootageSource = Extract<FootageSource, { kind: "audio" | "video" }>;

const START_LEAD_SECONDS = 0.02;
const CLICK_FADE_SECONDS = 0.005;
const MAX_ACTIVE_AUDIO_LAYERS = 128;
const MAX_REVERSED_CACHE_BYTES = 128 * 1024 * 1024;

interface ScheduledNode {
  source: AudioBufferSourceNode;
  nodes: AudioNode[];
}

interface ReversedEntry {
  buffer: AudioBuffer;
  bytes: number;
}

export interface AudioPlaybackSnapshot {
  playing: boolean;
  compositionTime: number;
  rangeEnd: number;
  scheduledLayers: number;
}

export class CompositionAudioPlaybackEngine {
  readonly #cache: AudioDecodeCache;
  readonly #contextFactory: () => AudioContext;
  readonly #reversed = new Map<string, ReversedEntry>();
  #context?: AudioContext;
  #master?: GainNode;
  #nodes: ScheduledNode[] = [];
  #anchorContextTime = 0;
  #anchorCompositionTime = 0;
  #rangeEnd = 0;
  #playing = false;
  #generation = 0;
  #reversedBytes = 0;

  constructor(
    cache: AudioDecodeCache = sharedAudioDecodeCache,
    contextFactory: () => AudioContext = () => new AudioContext({ latencyHint: "interactive" }),
  ) {
    this.#cache = cache;
    this.#contextFactory = contextFactory;
  }

  async play(
    project: Project,
    composition: Composition,
    startTime: number,
    rangeEnd: number,
  ): Promise<AudioPlaybackSnapshot> {
    validateRange(composition, startTime, rangeEnd);
    const generation = ++this.#generation;
    const context = this.#context ?? this.#createContext();
    if (context.state === "suspended") await context.resume();
    this.#releaseNodes(context.currentTime);
    this.#anchorCompositionTime = startTime;
    this.#rangeEnd = rangeEnd;
    this.#playing = false;

    const layers = audibleCompositionLayers(composition).slice(0, MAX_ACTIVE_AUDIO_LAYERS);
    const prepared = await Promise.all(
      layers.map(async (layer) => {
        const source = sourceForLayer(project, layer);
        if (!source || (source.kind !== "audio" && source.kind !== "video")) return undefined;
        try {
          const decoded = await this.#cache.decode(context, source);
          return { layer, source, decoded };
        } catch (error) {
          logger.warn(
            "audio",
            "source_schedule_failed",
            {
              sourceId: source.id,
            },
            error,
          );
          return undefined;
        }
      }),
    );
    if (generation !== this.#generation) return this.snapshot();
    const master = this.#master;
    if (!master) throw new Error("Audio output graph is unavailable");
    const when = context.currentTime + START_LEAD_SECONDS;
    master.gain.cancelScheduledValues(context.currentTime);
    master.gain.setValueAtTime(0, context.currentTime);
    master.gain.linearRampToValueAtTime(1, when + CLICK_FADE_SECONDS);
    this.#anchorContextTime = when;
    this.#playing = true;
    for (const entry of prepared) {
      if (!entry) continue;
      const scheduled = this.#scheduleLayer(
        context,
        master,
        entry.layer,
        entry.source,
        entry.decoded,
        startTime,
        rangeEnd,
        when,
      );
      if (scheduled) this.#nodes.push(scheduled);
    }
    return this.snapshot();
  }

  async seek(
    project: Project,
    composition: Composition,
    time: number,
    rangeEnd = this.#rangeEnd,
  ): Promise<AudioPlaybackSnapshot> {
    return this.play(project, composition, time, rangeEnd);
  }

  waveformPeaks(
    source: FootageSource,
    binCount: number,
    signal?: AbortSignal,
  ): Promise<Float32Array> {
    const context = this.#context ?? this.#createContext();
    return this.#cache.waveformPeaks(context, source, binCount, signal);
  }

  async decodedPcm(source: AudioFootageSource, signal?: AbortSignal): Promise<DecodedPcm> {
    const context = this.#context ?? this.#createContext();
    const buffer = await this.#cache.decode(context, source, signal);
    return {
      sampleRate: buffer.sampleRate,
      channels: Array.from({ length: buffer.numberOfChannels }, (_, channel) =>
        buffer.getChannelData(channel),
      ),
    };
  }

  pause(): AudioPlaybackSnapshot {
    this.#generation += 1;
    this.#playing = false;
    if (this.#context) this.#releaseNodes(this.#context.currentTime);
    return this.snapshot();
  }

  compositionTime(): number {
    if (!this.#playing || !this.#context) return this.#anchorCompositionTime;
    return Math.min(
      this.#rangeEnd,
      this.#anchorCompositionTime +
        Math.max(0, this.#context.currentTime - this.#anchorContextTime),
    );
  }

  snapshot(): AudioPlaybackSnapshot {
    return {
      playing: this.#playing,
      compositionTime: this.compositionTime(),
      rangeEnd: this.#rangeEnd,
      scheduledLayers: this.#nodes.length,
    };
  }

  async dispose(): Promise<void> {
    this.pause();
    this.#reversed.clear();
    this.#reversedBytes = 0;
    const context = this.#context;
    this.#context = undefined;
    this.#master = undefined;
    if (context && context.state !== "closed") await context.close();
  }

  #createContext(): AudioContext {
    const context = this.#contextFactory();
    const compressor = context.createDynamicsCompressor();
    compressor.threshold.value = -1;
    compressor.knee.value = 6;
    compressor.ratio.value = 20;
    compressor.attack.value = 0.003;
    compressor.release.value = 0.08;
    const master = context.createGain();
    master.connect(compressor);
    compressor.connect(context.destination);
    this.#context = context;
    this.#master = master;
    return context;
  }

  #scheduleLayer(
    context: AudioContext,
    master: GainNode,
    layer: Layer,
    footage: AudioFootageSource,
    decoded: AudioBuffer,
    rangeStart: number,
    rangeEnd: number,
    anchorWhen: number,
  ): ScheduledNode | undefined {
    const start = Math.max(rangeStart, layer.inPoint);
    const end = Math.min(rangeEnd, layer.outPoint);
    if (end <= start) return undefined;
    const stretch = Math.max(0.01, layer.timeStretch ?? 1);
    const sourceDuration = Math.min(footage.duration, decoded.duration);
    const offset = evaluateLayerSourceTime(layer, start, sourceDuration);
    if (offset >= sourceDuration) return undefined;
    const availableCompositionSeconds = (sourceDuration - offset) * stretch;
    const compositionDuration = Math.min(end - start, availableCompositionSeconds);
    if (compositionDuration <= 0) return undefined;
    const playbackBuffer = layer.audio?.reversed
      ? this.#reversedBuffer(context, footage, decoded)
      : decoded;
    const source = context.createBufferSource();
    source.buffer = playbackBuffer;
    source.playbackRate.value = 1 / stretch;
    const splitter = context.createChannelSplitter(Math.max(2, decoded.numberOfChannels));
    const left = context.createGain();
    const right = context.createGain();
    const merger = context.createChannelMerger(2);
    const settings = layer.audio ?? {
      levelsDb: [0, 0] as [number, number],
      pan: 0,
      muted: false,
      reversed: false,
    };
    left.gain.value =
      decibelsToLinear(settings.levelsDb[0]) * Math.sqrt(1 - Math.max(0, settings.pan));
    right.gain.value =
      decibelsToLinear(settings.levelsDb[1]) * Math.sqrt(1 + Math.min(0, settings.pan));
    source.connect(splitter);
    splitter.connect(left, 0);
    splitter.connect(right, Math.min(1, decoded.numberOfChannels - 1));
    left.connect(merger, 0, 0);
    right.connect(merger, 0, 1);
    merger.connect(master);
    const when = anchorWhen + (start - rangeStart);
    source.start(when, offset, compositionDuration / stretch);
    source.stop(when + compositionDuration + CLICK_FADE_SECONDS);
    return { source, nodes: [source, splitter, left, right, merger] };
  }

  #reversedBuffer(
    context: AudioContext,
    footage: AudioFootageSource,
    decoded: AudioBuffer,
  ): AudioBuffer {
    const cached = this.#reversed.get(footage.contentIdentity);
    if (cached) {
      this.#reversed.delete(footage.contentIdentity);
      this.#reversed.set(footage.contentIdentity, cached);
      return cached.buffer;
    }
    const bytes = decoded.length * decoded.numberOfChannels * Float32Array.BYTES_PER_ELEMENT;
    if (bytes > MAX_REVERSED_CACHE_BYTES)
      throw new Error(`Reversed audio for ${footage.name} exceeds the playback cache budget`);
    while (this.#reversedBytes + bytes > MAX_REVERSED_CACHE_BYTES) {
      const oldest = this.#reversed.entries().next().value;
      if (!oldest) break;
      this.#reversed.delete(oldest[0]);
      this.#reversedBytes -= oldest[1].bytes;
    }
    const reversed = context.createBuffer(
      decoded.numberOfChannels,
      decoded.length,
      decoded.sampleRate,
    );
    for (let channel = 0; channel < decoded.numberOfChannels; channel += 1) {
      const input = decoded.getChannelData(channel);
      const output = reversed.getChannelData(channel);
      for (let index = 0; index < input.length; index += 1)
        output[index] = input[input.length - 1 - index];
    }
    this.#reversed.set(footage.contentIdentity, { buffer: reversed, bytes });
    this.#reversedBytes += bytes;
    return reversed;
  }

  #releaseNodes(now: number): void {
    const master = this.#master;
    if (master) {
      master.gain.cancelScheduledValues(now);
      master.gain.setValueAtTime(master.gain.value, now);
      master.gain.linearRampToValueAtTime(0, now + CLICK_FADE_SECONDS);
    }
    for (const entry of this.#nodes) {
      try {
        entry.source.stop(now + CLICK_FADE_SECONDS);
      } catch {
        // A source that already ended is safe to release.
      }
      const nodes = entry.nodes;
      globalThis.setTimeout(
        () => {
          for (const node of nodes) node.disconnect();
        },
        CLICK_FADE_SECONDS * 1_000 + 5,
      );
    }
    this.#nodes = [];
  }
}

function validateRange(composition: Composition, startTime: number, rangeEnd: number): void {
  if (
    !Number.isFinite(startTime) ||
    !Number.isFinite(rangeEnd) ||
    startTime < 0 ||
    rangeEnd <= startTime ||
    rangeEnd > composition.duration
  )
    throw new RangeError("Audio playback range must stay inside the composition");
}

export const sharedAudioPlaybackEngine = new CompositionAudioPlaybackEngine();
