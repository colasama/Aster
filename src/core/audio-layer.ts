import type { AudioLayerSettings, Layer } from "./types";

export const MIN_AUDIO_LEVEL_DB = -192;
export const MAX_AUDIO_LEVEL_DB = 24;
export const MIN_AUDIO_PAN = -1;
export const MAX_AUDIO_PAN = 1;

export function layerHasAudio(layer: Layer): boolean {
  return layer.kind === "audio" || layer.kind === "video";
}

export function normalizeAudioLayerSettings(settings: AudioLayerSettings): AudioLayerSettings {
  return {
    levelsDb: [boundedDb(settings.levelsDb[0]), boundedDb(settings.levelsDb[1])],
    pan: bounded(settings.pan, MIN_AUDIO_PAN, MAX_AUDIO_PAN, 0),
    muted: settings.muted === true,
    reversed: settings.reversed === true,
  };
}

export function decibelsToLinear(decibels: number): number {
  if (!Number.isFinite(decibels) || decibels <= MIN_AUDIO_LEVEL_DB) return 0;
  return Math.min(16, 10 ** (decibels / 20));
}

export function linearToDecibels(gain: number): number {
  if (!Number.isFinite(gain) || gain <= 0) return MIN_AUDIO_LEVEL_DB;
  return bounded(20 * Math.log10(gain), MIN_AUDIO_LEVEL_DB, MAX_AUDIO_LEVEL_DB, 0);
}

function boundedDb(value: number): number {
  return bounded(value, MIN_AUDIO_LEVEL_DB, MAX_AUDIO_LEVEL_DB, 0);
}

function bounded(value: number, minimum: number, maximum: number, fallback: number): number {
  return Number.isFinite(value) ? Math.max(minimum, Math.min(maximum, value)) : fallback;
}
