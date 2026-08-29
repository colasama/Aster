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
    expect(
      resolvePreviewAudioState({
        audioEnabled: true,
        audio: { levelsDb: [-6.0206, -6.0206], pan: 0, muted: false, reversed: false },
      }),
    ).toEqual({
      enabled: true,
      gain: expect.closeTo(0.5, 4),
      muted: false,
    });
    expect(resolvePreviewAudioState({ audioEnabled: false }).muted).toBe(true);
  });

  it("applies bounded volume and mute to the media element", () => {
    const video = { muted: false, volume: 0 } as HTMLVideoElement;
    configurePreviewVideoAudio(video, { audioEnabled: true });
    expect(video.volume).toBe(0);
    expect(video.muted).toBe(true);
    configurePreviewVideoAudio(video, { audioEnabled: false });
    expect(video.muted).toBe(true);
  });
});
