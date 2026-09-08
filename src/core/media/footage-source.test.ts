import { describe, expect, it } from "vitest";
import { createLayerForComposition } from "../layers/layer-factory";
import { activeComposition, createBlankProject } from "../project/project";
import type { FootageSource } from "../types";
import { sourceSupportsLayer } from "./footage-source";

const base = {
  mimeType: "video/mp4",
  contentIdentity: "sha256:video",
  interpretation: { alpha: "straight" as const, colorSpace: "srgb" as const },
  width: 320,
  height: 180,
  duration: 2,
};

describe("footage source compatibility", () => {
  it("only binds video footage to audio layers when an audio stream exists", () => {
    const composition = activeComposition(createBlankProject());
    const layer = createLayerForComposition("audio", composition);
    const silentVideo: FootageSource = {
      ...base,
      id: "silent-video",
      kind: "video",
      name: "silent.mp4",
    };
    const videoWithAudio: FootageSource = {
      ...silentVideo,
      id: "video-with-audio",
      audio: { channels: 2, sampleRate: 48_000, streamIndex: 1 },
    };

    expect(sourceSupportsLayer(silentVideo, layer)).toBe(false);
    expect(sourceSupportsLayer(videoWithAudio, layer)).toBe(true);
  });
});
