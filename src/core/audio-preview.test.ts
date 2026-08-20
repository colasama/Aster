import { describe, expect, it } from "vitest";
import {
  configurePreviewVideoAudio,
  normalizePreviewAudioGain,
  resolvePreviewAudioState,
} from "./audio-preview";

describe("preview audio", () => {
  it("normalizes persisted gain and derives mute state", () => {
    expect(normalizePreviewAudioGain(undefined)).toBe(1);
    expect(normalizePreviewAudioGain(Number.NaN)).toBe(1);
    expect(normalizePreviewAudioGain(-2)).toBe(0);
    expect(normalizePreviewAudioGain(2)).toBe(1);
    expect(resolvePreviewAudioState({ audioEnabled: true, audioGain: 0.35 })).toEqual({
      enabled: true,
      gain: 0.35,
      muted: false,
    });
    expect(resolvePreviewAudioState({ audioEnabled: false, audioGain: 1 }).muted).toBe(true);
  });

  it("applies bounded volume and mute to the media element", () => {
    const video = { muted: false, volume: 0 } as HTMLVideoElement;
    configurePreviewVideoAudio(video, { audioEnabled: true, audioGain: 0.6 });
    expect(video.volume).toBe(0.6);
    expect(video.muted).toBe(false);
    configurePreviewVideoAudio(video, { audioEnabled: false, audioGain: 0.6 });
    expect(video.muted).toBe(true);
  });
});
