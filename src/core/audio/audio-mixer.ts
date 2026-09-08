import { evaluateLayerSourceTime } from "../animation/layer-time";
import type { Composition, Id, Layer, Project } from "../types";
import { decibelsToLinear, layerHasAudio } from "./audio-layer";

export const DEFAULT_MIX_SAMPLE_RATE = 48_000;
export const MAX_MIX_SAMPLE_RATE = 192_000;
export const MAX_MIX_BYTES = 256 * 1024 * 1024;

export interface DecodedPcm {
  sampleRate: number;
  channels: readonly Float32Array[];
}

export interface AudioMixRequest {
  startTime: number;
  endTime: number;
  sampleRate?: number;
  masterLevelDb?: number;
  clipProtection?: "normalize" | "limit" | "none";
}

export interface AudioMixResult {
  samples: Float32Array;
  sampleRate: number;
  channels: 2;
  frameCount: number;
  peak: number;
  protectionGain: number;
}

export function evaluateLayerAudioSourceTime(
  layer: Layer,
  compositionTime: number,
  sourceDuration: number,
): number | undefined {
  if (
    !layerHasAudio(layer) ||
    !Number.isFinite(compositionTime) ||
    compositionTime < layer.inPoint ||
    compositionTime >= layer.outPoint ||
    sourceDuration <= 0
  )
    return undefined;
  const forward = evaluateLayerSourceTime(layer, compositionTime, sourceDuration);
  return layer.audio?.reversed ? Math.max(0, sourceDuration - forward) : forward;
}

export function audibleCompositionLayers(composition: Composition): Layer[] {
  const audioSolo = composition.layers.some((layer) => layer.kind === "audio" && layer.solo);
  const videoSolo = composition.layers.some((layer) => layer.kind === "video" && layer.solo);
  return composition.layers.filter((layer) => {
    if (!layerHasAudio(layer) || layer.audioEnabled === false || layer.audio?.muted) return false;
    if (layer.kind === "audio" && audioSolo && !layer.solo) return false;
    if (layer.kind === "video" && videoSolo && !layer.solo) return false;
    return true;
  });
}

export function mixCompositionAudio(
  project: Project,
  composition: Composition,
  decodedBySourceId: ReadonlyMap<Id, DecodedPcm>,
  request: AudioMixRequest,
): AudioMixResult {
  const sampleRate = request.sampleRate ?? DEFAULT_MIX_SAMPLE_RATE;
  if (!Number.isSafeInteger(sampleRate) || sampleRate < 8_000 || sampleRate > MAX_MIX_SAMPLE_RATE)
    throw new RangeError("Mix sample rate must be an integer from 8000 through 192000 Hz");
  if (
    !Number.isFinite(request.startTime) ||
    !Number.isFinite(request.endTime) ||
    request.startTime < 0 ||
    request.endTime <= request.startTime ||
    request.endTime > composition.duration
  )
    throw new RangeError("Audio mix range must stay inside the composition");
  const frameCount = Math.ceil((request.endTime - request.startTime) * sampleRate);
  if (
    !Number.isSafeInteger(frameCount) ||
    frameCount * 2 * Float32Array.BYTES_PER_ELEMENT > MAX_MIX_BYTES
  )
    throw new RangeError("Audio mix range exceeds the bounded PCM output budget");
  const samples = new Float32Array(frameCount * 2);
  const sourceById = new Map(project.sources.map((source) => [source.id, source]));

  for (const layer of audibleCompositionLayers(composition)) {
    if (!layer.sourceId) continue;
    const source = sourceById.get(layer.sourceId);
    const decoded = decodedBySourceId.get(layer.sourceId);
    if (
      !source ||
      (source.kind !== "audio" && source.kind !== "video") ||
      !decoded ||
      decoded.channels.length === 0
    )
      continue;
    validateDecodedPcm(decoded);
    const audio = layer.audio ?? { levelsDb: [0, 0], pan: 0, muted: false, reversed: false };
    const leftGain = decibelsToLinear(audio.levelsDb[0]) * Math.sqrt(1 - Math.max(0, audio.pan));
    const rightGain = decibelsToLinear(audio.levelsDb[1]) * Math.sqrt(1 + Math.min(0, audio.pan));
    const sourceDuration = Math.min(
      source.duration,
      decoded.channels[0].length / decoded.sampleRate,
    );
    for (let frame = 0; frame < frameCount; frame += 1) {
      const compositionTime = request.startTime + frame / sampleRate;
      const sourceTime = evaluateLayerAudioSourceTime(layer, compositionTime, sourceDuration);
      if (sourceTime === undefined) continue;
      const sourceFrame = Math.min(
        Math.max(0, sourceTime * decoded.sampleRate),
        Math.max(0, decoded.channels[0].length - 1),
      );
      const left = sampleLinear(decoded.channels[0], sourceFrame);
      const right = sampleLinear(
        decoded.channels[Math.min(1, decoded.channels.length - 1)],
        sourceFrame,
      );
      samples[frame * 2] += left * leftGain;
      samples[frame * 2 + 1] += right * rightGain;
    }
  }

  const masterGain = decibelsToLinear(request.masterLevelDb ?? 0);
  let peak = 0;
  for (let index = 0; index < samples.length; index += 1) {
    samples[index] *= masterGain;
    peak = Math.max(peak, Math.abs(samples[index]));
  }
  const clipProtection = request.clipProtection ?? "normalize";
  const protectionGain = clipProtection === "normalize" && peak > 1 ? 0.999 / peak : 1;
  if (protectionGain < 1) {
    for (let index = 0; index < samples.length; index += 1) samples[index] *= protectionGain;
  } else if (clipProtection === "limit" && peak > 1) {
    for (let index = 0; index < samples.length; index += 1)
      samples[index] = Math.max(-0.999, Math.min(0.999, samples[index]));
  }
  return { samples, sampleRate, channels: 2, frameCount, peak, protectionGain };
}

function sampleLinear(samples: Float32Array, position: number): number {
  if (samples.length === 0) return 0;
  const first = Math.min(samples.length - 1, Math.floor(position));
  const second = Math.min(samples.length - 1, first + 1);
  const fraction = position - first;
  const left = Number.isFinite(samples[first]) ? samples[first] : 0;
  const right = Number.isFinite(samples[second]) ? samples[second] : 0;
  return left + (right - left) * fraction;
}

function validateDecodedPcm(decoded: DecodedPcm): void {
  if (
    !Number.isSafeInteger(decoded.sampleRate) ||
    decoded.sampleRate < 8_000 ||
    decoded.sampleRate > MAX_MIX_SAMPLE_RATE ||
    decoded.channels.length < 1 ||
    decoded.channels.length > 32
  )
    throw new RangeError("Decoded audio metadata is invalid");
  const frames = decoded.channels[0].length;
  if (decoded.channels.some((channel) => channel.length !== frames))
    throw new RangeError("Decoded audio channels must have equal frame counts");
}
