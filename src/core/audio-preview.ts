import { decibelsToLinear } from "./audio-layer";
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
  layer: Pick<Layer, "audioEnabled" | "audio">,
): PreviewAudioState {
  const enabled = layer.audioEnabled !== false;
  const gain = normalizePreviewAudioGain(
    layer.audio
      ? (decibelsToLinear(layer.audio.levelsDb[0]) + decibelsToLinear(layer.audio.levelsDb[1])) / 2
      : 1,
  );
  return {
    enabled,
    gain,
    muted: !enabled || layer.audio?.muted === true || gain <= Number.EPSILON,
  };
}

export function configurePreviewVideoAudio(
  video: HTMLVideoElement,
  _layer: Pick<Layer, "audioEnabled">,
): void {
  // Video elements are visual decode clocks only. The shared Web Audio graph owns all output so
  // seeks, layer mixing, loop boundaries, and export use one deterministic audio path.
  video.volume = 0;
  video.muted = true;
}
