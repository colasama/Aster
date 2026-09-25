// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import type { AsterDesktopApi } from "../../desktop/api";
import { mediaImportRuntime } from "../../importers/media-import-runtime";
import { sharedAudioPlaybackEngine } from "../audio/audio-playback-engine";
import { createLayerForComposition } from "../layers/layer-factory";
import { createBlankProject } from "../project/project";
import {
  captureForegroundRenderProjectSnapshot,
  captureRenderProjectSnapshot,
  type FrameRenderSession,
  type FrameRenderSessionOpenRequest,
  frameTimeAtIndex,
  renderMp4,
  streamFramePipeline,
} from "./render-export";

describe("MP4 frame pipeline", () => {
  it("captures one immutable project/composition document for picture and audio", () => {
    const project = createBlankProject();
    const composition = project.compositions[0];
    const captured = captureRenderProjectSnapshot(project, composition);
    composition.width = 123;
    composition.layers[0].name = "edited after capture";

    expect(captured.project).not.toBe(project);
    expect(captured.composition).not.toBe(composition);
    expect(captured.project.activeCompositionId).toBe(captured.composition.id);
    expect(captured.composition.width).not.toBe(123);
    expect(captured.composition.layers[0].name).not.toBe("edited after capture");
  });

  it("preserves ephemeral runtime locators required by foreground picture and audio", () => {
    const project = createBlankProject();
    project.sources.push({
      id: "linked-video",
      kind: "video",
      name: "linked.mp4",
      mimeType: "video/mp4",
      contentIdentity: "sha256:linked",
      relativePath: "assets/linked.mp4",
      runtimeUrl: "aster-asset://local/C%3A%5Cproject%5Cassets%5Clinked.mp4",
      width: 1920,
      height: 1080,
      duration: 1,
      interpretation: { alpha: "straight", colorSpace: "srgb" },
    });

    const captured = captureRenderProjectSnapshot(project, project.compositions[0]);

    expect(captured.project.sources[0]?.runtimeUrl).toBe(project.sources[0]?.runtimeUrl);
    project.sources[0].runtimeUrl = "changed-after-export";
    expect(captured.project.sources[0]?.runtimeUrl).not.toBe("changed-after-export");
  });

  it("leases an immutable advanced-media generation under export-only source ids", async () => {
    const project = createBlankProject();
    const composition = project.compositions[0];
    const source = {
      id: "psd-source",
      kind: "psd" as const,
      name: "Hero",
      mimeType: "image/vnd.adobe.photoshop",
      contentIdentity: "psd:test:merged:hero",
      runtimeUrl: "aster-runtime://media/psd-source",
      width: 1,
      height: 1,
      layerCount: 1,
      interpretation: { alpha: "straight" as const, colorSpace: "srgb" as const },
    };
    project.sources.push(source);
    const layer = createLayerForComposition("image", composition);
    layer.sourceId = source.id;
    composition.layers.push(layer);
    const pixels = new Uint8ClampedArray([1, 2, 3, 4]);
    mediaImportRuntime.register(source.id, {
      kind: "psd",
      documentIdentity: "psd:test",
      importMode: "merged",
      layerKey: "hero",
      decodedWidth: 1,
      decodedHeight: 1,
      crop: [0, 0, 1, 1],
      pixels,
    });

    const captured = await captureForegroundRenderProjectSnapshot(project, composition);
    const capturedSource = captured.project.sources.find(
      (candidate) => candidate.contentIdentity === source.contentIdentity,
    );
    if (!capturedSource) throw new Error("Captured PSD source is unavailable");
    const temporaryId = capturedSource.id;
    expect(temporaryId).not.toBe(source.id);
    pixels.fill(255);
    mediaImportRuntime.remove(source.id);

    const runtime = mediaImportRuntime.get(temporaryId);
    expect(runtime).toMatchObject({ kind: "psd", layerKey: "hero" });
    if (runtime?.kind !== "psd") throw new Error("Captured PSD runtime is unavailable");
    expect([...runtime.pixels]).toEqual([1, 2, 3, 4]);

    captured.mediaLease.dispose();
    expect(mediaImportRuntime.get(temporaryId)).toBeUndefined();
  });

  it("rejects a composition outside the captured project", () => {
    const project = createBlankProject();
    expect(() =>
      captureRenderProjectSnapshot(project, { ...project.compositions[0], id: "missing" }),
    ).toThrow("not present");
  });

  it("addresses fractional-rate video frames without cumulative time drift", () => {
    const rate = { numerator: 30_000, denominator: 1_001 };
    expect(frameTimeAtIndex(0, rate)).toBe(0);
    expect(frameTimeAtIndex(17_982, rate)).toBe((17_982 * 1_001) / 30_000);
    expect(() => frameTimeAtIndex(-1, rate)).toThrow("frame index");
  });

  it("keeps a bounded render window and writes frames in timeline order", async () => {
    const rendered: number[] = [];
    const written: number[] = [];
    let maximumWindow = 0;
    const completed = await streamFramePipeline({
      frameCount: 8,
      maxInFlight: 3,
      cancelled: () => false,
      render: async (frame) => {
        rendered.push(frame);
        maximumWindow = Math.max(maximumWindow, rendered.length - written.length);
        return frame;
      },
      write: async (frame) => {
        written.push(frame);
      },
      onProgress: () => undefined,
    });
    expect(completed).toBe(8);
    expect(written).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    // Three GPU readbacks plus the frame currently handed to the encoder remain bounded.
    expect(maximumWindow).toBeLessThanOrEqual(4);
  });

  it("stops after the current encoded frame and drains submitted renders", async () => {
    let shouldCancel = false;
    const written: number[] = [];
    const completed = await streamFramePipeline({
      frameCount: 10,
      maxInFlight: 3,
      cancelled: () => shouldCancel,
      render: async (frame) => frame,
      write: async (frame) => {
        written.push(frame);
        if (frame === 1) shouldCancel = true;
      },
      onProgress: () => undefined,
    });
    expect(completed).toBe(2);
    expect(written).toEqual([0, 1]);
  });

  it("releases a blocked encoder audio write when the export is cancelled", async () => {
    const project = createBlankProject();
    const composition = project.compositions[0];
    composition.width = 64;
    composition.height = 64;
    composition.duration = 60;
    composition.frameRate = { numerator: 30, denominator: 1 };
    const source = {
      id: "audio-source",
      kind: "audio" as const,
      name: "tone.wav",
      mimeType: "audio/wav",
      contentIdentity: "sha256:tone",
      dataUrl: "data:audio/wav;base64,AAAA",
      duration: 60,
      channels: 1,
      sampleRate: 48_000,
      streamIndex: 0,
      interpretation: { alpha: "ignore" as const, colorSpace: "srgb" as const },
    };
    project.sources.push(source);
    const layer = createLayerForComposition("audio", composition);
    layer.sourceId = source.id;
    composition.layers.push(layer);

    const decode = vi
      .spyOn(sharedAudioPlaybackEngine, "decodedPcm")
      .mockResolvedValue({ sampleRate: 48_000, channels: [new Float32Array(2_880_000)] });

    let cancelled = false;
    const audioWriteRejects: Array<(error: Error) => void> = [];
    const api = {
      save: vi.fn(async () => "C:/exports/out.mp4"),
      startMp4Export: vi.fn(async () => ({ jobId: "job-1", encoder: "libx264" as const })),
      writeMp4Frame: vi.fn(async () => undefined),
      // FFmpeg drains the auxiliary audio input at mux pace; model the backpressured write
      // that only releases once the native session destroys its input streams.
      writeMp4Audio: vi.fn(
        () =>
          new Promise<void>((_resolve, reject) => {
            cancelled = true;
            audioWriteRejects.push(reject);
          }),
      ),
      finishMp4Export: vi.fn(),
      log: vi.fn(),
      cancelMp4Export: vi.fn(async () => {
        for (const reject of audioWriteRejects.splice(0))
          reject(new Error("MP4 export input is already closed"));
      }),
    };
    window.asterDesktop = api as unknown as AsterDesktopApi;

    const session: FrameRenderSession = {
      renderFrame: async () => new Blob(),
      renderRawFrame: async () => ({
        pixels: new ArrayBuffer(64 * 64 * 4),
        pixelFormat: "rgba",
      }),
      rawPixelFormat: "rgba",
      width: 64,
      height: 64,
      maxInFlightFrames: 2,
      videoSynchronization: "none",
      close: () => undefined,
    };
    const openSession = (event: Event) => {
      const request = event as CustomEvent<FrameRenderSessionOpenRequest>;
      request.detail.resolve(session);
    };
    window.addEventListener("aster:open-render-session", openSession);

    try {
      const result = await renderMp4(
        project,
        composition,
        () => undefined,
        () => cancelled,
      );
      expect(result).toMatchObject({ cancelled: true });
      expect(api.cancelMp4Export).toHaveBeenCalledTimes(1);
      expect(api.finishMp4Export).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener("aster:open-render-session", openSession);
      delete window.asterDesktop;
      decode.mockRestore();
    }
  });

  it.each(["render", "write"] as const)(
    "drains accepted GPU work before propagating a %s failure",
    async (stage) => {
      let release!: (value: number) => void;
      const pending = new Promise<number>((resolve) => {
        release = resolve;
      });
      let settled = false;
      const render = vi.fn(async (frame: number) => {
        if (frame > 0) return pending;
        if (stage === "render") throw new Error("render failed");
        return frame;
      });
      const result = streamFramePipeline({
        frameCount: 10,
        maxInFlight: 3,
        cancelled: () => false,
        render,
        write: async () => {
          throw new Error("write failed");
        },
        onProgress: () => undefined,
      }).catch((error: unknown) => {
        settled = true;
        return error;
      });
      await vi.waitFor(() => expect(render).toHaveBeenCalled());
      expect(settled).toBe(false);
      expect(render.mock.calls.length).toBeLessThanOrEqual(4);
      release(1);
      await expect(result).resolves.toMatchObject({ message: `${stage} failed` });
    },
  );
});
