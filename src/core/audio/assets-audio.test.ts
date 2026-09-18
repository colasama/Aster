// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import type { AsterDesktopApi } from "../../desktop/api";
import { mediaImportRuntime } from "../../importers/media-import-runtime";
import {
  createMediaLayerForSource,
  createMediaLayerFromFile,
  importMediaLayer,
} from "../media/assets";
import { createBlankProject } from "../project/project";

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
  mediaImportRuntime.clear();
  window.asterDesktop = undefined;
  vi.unstubAllGlobals();
});

describe("audio footage importer", () => {
  it("centers fitted visual footage in its source space", () => {
    const composition = createBlankProject(true).compositions[0];
    const source = {
      id: crypto.randomUUID(),
      kind: "still" as const,
      name: "plate.png",
      mimeType: "image/png",
      contentIdentity: "test:plate",
      dataUrl: "data:image/png;base64,AA==",
      width: 3840,
      height: 2160,
      interpretation: { alpha: "straight" as const, colorSpace: "srgb" as const },
    };

    const layer = createMediaLayerForSource(source, composition, 0);

    expect(layer.size).toEqual([1920, 1080]);
    expect(layer.transform.anchor).toMatchObject([
      { mode: "static", value: 960 },
      { mode: "static", value: 540 },
      { mode: "static", value: 0 },
    ]);
  });

  it("creates another independent audio layer from an existing source", () => {
    const composition = createBlankProject(true).compositions[0];
    const source = {
      id: crypto.randomUUID(),
      kind: "audio" as const,
      name: "dialogue.wav",
      mimeType: "audio/wav",
      contentIdentity: "test:dialogue",
      dataUrl: "data:audio/wav;base64,AA==",
      duration: 2,
      channels: 2,
      sampleRate: 48_000,
      streamIndex: 0,
      interpretation: { alpha: "ignore" as const, colorSpace: "srgb" as const },
    };
    const layer = createMediaLayerForSource(source, composition, 1);
    expect(layer).toMatchObject({ kind: "audio", name: "dialogue", sourceId: source.id });
    expect(layer.outPoint).toBe(3);
  });

  it("creates a source-backed non-visual audio layer and accepts M4A video/mp4 MIME", async () => {
    vi.stubGlobal("AudioContext", FakeAudioContext);
    const composition = createBlankProject(true).compositions[0];
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

  it("retains a picker-authorized native path instead of creating an embedded data URL", async () => {
    vi.stubGlobal("AudioContext", FakeAudioContext);
    const composition = createBlankProject(true).compositions[0];
    const imported = await createMediaLayerFromFile(
      "audio",
      new File([new Uint8Array([1, 2, 3])], "dialogue.wav", { type: "audio/wav" }),
      composition,
      0,
      {
        runtimeUrl: "aster-asset://local/dialogue.wav",
        sourcePath: "C:\\Media\\dialogue.wav",
      },
    );
    expect(imported.source).toMatchObject({
      kind: "audio",
      runtimeUrl: "aster-asset://local/dialogue.wav",
    });
    expect(imported.source.dataUrl).toBeUndefined();
    expect(mediaImportRuntime.get(imported.source.id)).toEqual({
      kind: "audio",
      originalPath: "C:\\Media\\dialogue.wav",
    });
  });

  it("uses the authorized desktop picker path for audio imports", async () => {
    vi.stubGlobal("AudioContext", FakeAudioContext);
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "audio/wav" } }),
        ),
    );
    const open = vi.fn().mockResolvedValue("C:\\Media\\tone.wav");
    window.asterDesktop = {
      open,
      convertFileSrc: (path: string) => `aster-asset://local/${encodeURIComponent(path)}`,
    } as unknown as AsterDesktopApi;

    const imported = await importMediaLayer("audio", createBlankProject(true).compositions[0], 0);
    expect(open).toHaveBeenCalledWith(expect.objectContaining({ title: "Choose audio asset" }));
    expect(imported?.source).toMatchObject({
      kind: "audio",
      runtimeUrl: expect.stringMatching(/^aster-asset:/),
    });
    expect(imported?.source.dataUrl).toBeUndefined();
    expect(imported && mediaImportRuntime.get(imported.source.id)).toEqual({
      kind: "audio",
      originalPath: "C:\\Media\\tone.wav",
    });
  });

  it("reports decoder capability failures and rejects unsupported extensions", async () => {
    vi.stubGlobal("AudioContext", FakeAudioContext);
    FakeAudioContext.failure = new Error("codec unavailable");
    const composition = createBlankProject(true).compositions[0];
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
