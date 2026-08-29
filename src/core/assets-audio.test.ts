// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import { createMediaLayerFromFile } from "./assets";
import { createBlankProject } from "./project";

class FakeAudioContext {
  static failure: Error | undefined;

  async decodeAudioData(): Promise<AudioBuffer> {
    if (FakeAudioContext.failure) throw FakeAudioContext.failure;
    return {
      duration: 2,
      numberOfChannels: 2,
      sampleRate: 48_000,
    } as AudioBuffer;
  }

  async close(): Promise<void> {}
}

afterEach(() => {
  FakeAudioContext.failure = undefined;
  vi.unstubAllGlobals();
});

describe("audio footage importer", () => {
  it("creates a source-backed non-visual audio layer and accepts M4A video/mp4 MIME", async () => {
    vi.stubGlobal("AudioContext", FakeAudioContext);
    const composition = createBlankProject().compositions[0];
    const file = new File([new Uint8Array([1, 2, 3])], "music.m4a", { type: "video/mp4" });
    const imported = await createMediaLayerFromFile("audio", file, composition, 1);
    expect(imported.source).toMatchObject({
      kind: "audio",
      mimeType: "video/mp4",
      duration: 2,
      channels: 2,
      sampleRate: 48_000,
      streamIndex: 0,
    });
    expect(imported.layer).toMatchObject({
      kind: "audio",
      visible: false,
      size: [0, 0],
      sourceId: imported.source.id,
      inPoint: 1,
      outPoint: 3,
    });
  });

  it("reports decoder capability failures and rejects unsupported extensions", async () => {
    vi.stubGlobal("AudioContext", FakeAudioContext);
    FakeAudioContext.failure = new Error("codec unavailable");
    const composition = createBlankProject().compositions[0];
    await expect(
      createMediaLayerFromFile(
        "audio",
        new File([new Uint8Array([1])], "music.flac", { type: "audio/flac" }),
        composition,
        0,
      ),
    ).rejects.toThrow("This browser cannot decode music.flac");
    await expect(
      createMediaLayerFromFile(
        "audio",
        new File([new Uint8Array([1])], "music.wma", { type: "audio/x-ms-wma" }),
        composition,
        0,
      ),
    ).rejects.toThrow("supports WAV, MP3, AAC, M4A, OGG, and FLAC");
  });
});
