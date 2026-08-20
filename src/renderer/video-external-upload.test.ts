import { describe, expect, it, vi } from "vitest";
import { type MediaResource, mediaTextureExtent } from "./media-resource";
import {
  compareVideoProbeSamples,
  planVideoProbePatches,
  VideoExternalUpload,
  type VideoProbeResult,
} from "./video-external-upload";

function paddedRows(tight: Uint8Array, width: number, height: number): Uint8Array {
  const padded = new Uint8Array(256 * height);
  for (let y = 0; y < height; y += 1)
    padded.set(tight.subarray(y * width * 4, (y + 1) * width * 4), y * 256);
  return padded;
}

function fakeVideo(width = 640, height = 360, currentTime = 0): HTMLVideoElement {
  return { videoWidth: width, videoHeight: height, currentTime } as HTMLVideoElement;
}

describe("video external upload validation", () => {
  it("plans three bounded sample patches across a decoded frame", () => {
    expect(planVideoProbePatches(1_920, 1_080)).toEqual([
      { sourceX: 383, sourceY: 863, destinationY: 0, size: 2 },
      { sourceX: 959, sourceY: 539, destinationY: 2, size: 2 },
      { sourceX: 1_535, sourceY: 214, destinationY: 4, size: 2 },
    ]);
  });

  it("keeps probe patches valid for a one-pixel video", () => {
    expect(planVideoProbePatches(1, 1)).toEqual([
      { sourceX: 0, sourceY: 0, destinationY: 0, size: 1 },
      { sourceX: 0, sourceY: 0, destinationY: 1, size: 1 },
      { sourceX: 0, sourceY: 0, destinationY: 2, size: 1 },
    ]);
  });

  it("accepts close GPU readback values while ignoring row padding and alpha", () => {
    const reference = Uint8Array.from({ length: 48 }, (_, index) =>
      index % 4 === 3 ? 255 : 80 + index,
    );
    const gpu = Uint8Array.from(reference, (value, index) =>
      index % 4 === 3 ? 0 : Math.min(255, value + 3),
    );
    const result = compareVideoProbeSamples(reference, paddedRows(gpu, 2, 6), 2, 6);
    expect(result.matches).toBe(true);
    expect(result.reason).toBe("gpu-readback-matched-reference");
    expect(result.meanError).toBe(3);
  });

  it("rejects a silent-zero GPU readback", () => {
    const reference = new Uint8Array(48).fill(160);
    const result = compareVideoProbeSamples(reference, new Uint8Array(256 * 6), 2, 6);
    expect(result).toMatchObject({ matches: false, reason: "gpu-readback-mismatch" });
  });

  it("keeps an all-black reference conservative and on fallback", () => {
    const reference = new Uint8Array(48);
    const result = compareVideoProbeSamples(reference, new Uint8Array(256 * 6), 2, 6);
    expect(result).toEqual({ matches: false, reason: "reference-frame-inconclusive" });
  });

  it("does not validate a near-black reference against a silent-zero GPU frame", () => {
    const reference = new Uint8Array(48).fill(5);
    const result = compareVideoProbeSamples(reference, new Uint8Array(256 * 6), 2, 6);
    expect(result).toEqual({ matches: false, reason: "reference-frame-inconclusive" });
  });

  it("rejects oversized or truncated probe layouts", () => {
    expect(compareVideoProbeSamples(new Uint8Array(48), new Uint8Array(100), 2, 6)).toEqual({
      matches: false,
      reason: "invalid-probe-layout",
    });
    expect(compareVideoProbeSamples(new Uint8Array(48), new Uint8Array(2_048), 3, 6)).toEqual({
      matches: false,
      reason: "invalid-probe-layout",
    });
  });

  it("enables direct copies only after a successful asynchronous probe", async () => {
    let finishProbe: ((result: VideoProbeResult) => void) | undefined;
    const probe = vi.fn(
      () =>
        new Promise<VideoProbeResult>((resolve) => {
          finishProbe = resolve;
        }),
    );
    const copyExternalImageToTexture = vi.fn();
    const statuses: string[] = [];
    const upload = new VideoExternalUpload(
      { queue: { copyExternalImageToTexture } } as unknown as GPUDevice,
      fakeVideo(),
      {} as GPUTexture,
      640,
      360,
      { probe, onStatus: ({ mode }) => statuses.push(mode) },
    );
    upload.start();
    expect(upload.copyFrame()).toBe(false);
    finishProbe?.({ matches: true, reason: "gpu-readback-matched-reference" });
    await Promise.resolve();
    expect(upload.copyFrame()).toBe(true);
    expect(copyExternalImageToTexture).toHaveBeenCalledOnce();
    expect(statuses).toEqual(["validating", "direct"]);
  });

  it("permanently falls back if a validated direct copy throws", async () => {
    const copyExternalImageToTexture = vi.fn(() => {
      throw new Error("unsupported source");
    });
    const upload = new VideoExternalUpload(
      { queue: { copyExternalImageToTexture } } as unknown as GPUDevice,
      fakeVideo(),
      {} as GPUTexture,
      640,
      360,
      {
        probe: async () => ({ matches: true, reason: "gpu-readback-matched-reference" }),
      },
    );
    upload.start();
    await Promise.resolve();
    expect(upload.copyFrame()).toBe(false);
    expect(upload.status.mode).toBe("fallback");
    expect(upload.copyFrame()).toBe(false);
    expect(copyExternalImageToTexture).toHaveBeenCalledOnce();
  });

  it("ignores a late probe result after resource destruction", async () => {
    let finishProbe: ((result: VideoProbeResult) => void) | undefined;
    const statuses: string[] = [];
    const upload = new VideoExternalUpload(
      { queue: {} } as GPUDevice,
      fakeVideo(),
      {} as GPUTexture,
      640,
      360,
      {
        probe: () =>
          new Promise((resolve) => {
            finishProbe = resolve;
          }),
        onStatus: ({ mode }) => statuses.push(mode),
      },
    );
    upload.start();
    upload.destroy();
    finishProbe?.({ matches: true, reason: "gpu-readback-matched-reference" });
    await Promise.resolve();
    expect(statuses).toEqual(["validating"]);
  });

  it("retries temporary failures on later media times with bounded exponential backoff", async () => {
    let now = 0;
    const video = fakeVideo();
    const probe = vi
      .fn<() => Promise<VideoProbeResult>>()
      .mockResolvedValueOnce({ matches: false, reason: "reference-frame-inconclusive" })
      .mockRejectedValueOnce(new Error("Video upload validation timed out"))
      .mockResolvedValueOnce({ matches: true, reason: "gpu-readback-matched-reference" });
    const upload = new VideoExternalUpload(
      { queue: { copyExternalImageToTexture: vi.fn() } } as unknown as GPUDevice,
      video,
      {} as GPUTexture,
      640,
      360,
      { probe, now: () => now, retryBackoffMs: 100 },
    );
    upload.start();
    await Promise.resolve();
    video.currentTime = 1;
    expect(upload.copyFrame()).toBe(false);
    expect(probe).toHaveBeenCalledTimes(1);
    now = 100;
    upload.copyFrame();
    await Promise.resolve();
    expect(probe).toHaveBeenCalledTimes(2);
    video.currentTime = 2;
    now = 299;
    upload.copyFrame();
    expect(probe).toHaveBeenCalledTimes(2);
    now = 300;
    upload.copyFrame();
    await Promise.resolve();
    expect(probe).toHaveBeenCalledTimes(3);
    expect(upload.status.mode).toBe("direct");
  });

  it("makes a GPU mismatch permanent instead of retrying", async () => {
    let now = 0;
    const video = fakeVideo();
    const probe = vi.fn(async () => ({ matches: false, reason: "gpu-readback-mismatch" }));
    const upload = new VideoExternalUpload(
      { queue: {} } as GPUDevice,
      video,
      {} as GPUTexture,
      640,
      360,
      { probe, now: () => now, retryBackoffMs: 1 },
    );
    upload.start();
    await Promise.resolve();
    video.currentTime = 1;
    now = 10_000;
    upload.copyFrame();
    expect(probe).toHaveBeenCalledOnce();
    expect(upload.status.reason).toContain("permanent");
  });

  it("permanently falls back when the decoded extent changes after validation", async () => {
    const video = fakeVideo();
    const copyExternalImageToTexture = vi.fn();
    const upload = new VideoExternalUpload(
      { queue: { copyExternalImageToTexture } } as unknown as GPUDevice,
      video,
      {} as GPUTexture,
      640,
      360,
      { probe: async () => ({ matches: true, reason: "gpu-readback-matched-reference" }) },
    );
    upload.start();
    await Promise.resolve();
    Object.assign(video, { videoWidth: 1_280, videoHeight: 720 });
    expect(upload.copyFrame()).toBe(false);
    expect(copyExternalImageToTexture).not.toHaveBeenCalled();
    expect(upload.status.reason).toBe("decoded-extent-changed;permanent");
  });

  it("keeps fallback upload dimensions fixed to the texture extent", () => {
    const resource = {
      source: "clip.mp4",
      kind: "video",
      textureWidth: 960,
      textureHeight: 540,
      video: fakeVideo(1_920, 1_080),
    } satisfies MediaResource;
    expect(mediaTextureExtent(resource)).toEqual([960, 540]);
  });
});
