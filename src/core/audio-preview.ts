import type { Layer } from "./types";

export const MIN_PREVIEW_AUDIO_GAIN = 0;
export const MAX_PREVIEW_AUDIO_GAIN = 1;

export interface PreviewAudioState {
  enabled: boolean;
  gain: number;
  muted: boolean;
}

export function normalizePreviewAudioGain(value: number | undefined): number {
  if (value === undefined) return 1;
  if (!Number.isFinite(value)) return 1;
  return Math.max(MIN_PREVIEW_AUDIO_GAIN, Math.min(MAX_PREVIEW_AUDIO_GAIN, value));
}

export function resolvePreviewAudioState(
  layer: Pick<Layer, "audioEnabled" | "audioGain">,
): PreviewAudioState {
  const enabled = layer.audioEnabled !== false;
  const gain = normalizePreviewAudioGain(layer.audioGain);
  return { enabled, gain, muted: !enabled || gain <= Number.EPSILON };
}

export function configurePreviewVideoAudio(
  video: HTMLVideoElement,
  layer: Pick<Layer, "audioEnabled" | "audioGain">,
): void {
  const state = resolvePreviewAudioState(layer);
  video.volume = state.gain;
  video.muted = state.muted;
}
