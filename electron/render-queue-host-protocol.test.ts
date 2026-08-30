// @vitest-environment node

import { describe, expect, it } from "vitest";
import { parseRenderHostOutputRequest } from "./render-queue-host-protocol";

describe("RenderHost IPC protocol", () => {
  it("accepts lease-correlated binary output messages", () => {
    const pixels = new ArrayBuffer(16);
    expect(
      parseRenderHostOutputRequest({
        type: "writeMp4Frame",
        jobId: "job",
        leaseId: "lease",
        outputId: "video",
        pixels,
      }),
    ).toEqual({
      type: "writeMp4Frame",
      jobId: "job",
      leaseId: "lease",
      outputId: "video",
      pixels,
    });
    expect(
      parseRenderHostOutputRequest({
        type: "startMp4",
        jobId: "job",
        leaseId: "lease",
        outputId: "video",
        pixelFormat: "rgba",
        videoBitrateBps: 20_000_000,
        audio: { sampleRate: 48_000, channels: 2, frameCount: 4_004 },
      }),
    ).toMatchObject({
      videoBitrateBps: 20_000_000,
      audio: { sampleRate: 48_000, channels: 2, frameCount: 4_004 },
    });
    const samples = new ArrayBuffer(48_000 * 2 * Float32Array.BYTES_PER_ELEMENT);
    expect(
      parseRenderHostOutputRequest({
        type: "writeMp4Audio",
        jobId: "job",
        leaseId: "lease",
        outputId: "video",
        samples,
      }),
    ).toMatchObject({ type: "writeMp4Audio", samples });
  });

  it("rejects unknown fields, malformed identities, and non-binary payloads", () => {
    expect(() =>
      parseRenderHostOutputRequest({
        type: "finishMp4",
        jobId: "job",
        leaseId: "lease",
        outputId: "video",
        injected: true,
      }),
    ).toThrow("fields");
    expect(() =>
      parseRenderHostOutputRequest({
        type: "writePng",
        jobId: "",
        leaseId: "lease",
        outputId: "still",
        frame: 0,
        pixels: new ArrayBuffer(8),
      }),
    ).toThrow("job ID");
    expect(() =>
      parseRenderHostOutputRequest({
        type: "writeMp4Frame",
        jobId: "job",
        leaseId: "lease",
        outputId: "video",
        pixels: new Uint8Array(4),
      }),
    ).toThrow("ArrayBuffer");
    expect(() =>
      parseRenderHostOutputRequest({
        type: "startMp4",
        jobId: "job",
        leaseId: "lease",
        outputId: "video",
        pixelFormat: "rgba",
        videoBitrateBps: 20_000_000,
        audio: { sampleRate: 48_000, channels: 1, frameCount: 4_004 },
      }),
    ).toThrow("bounds");
    expect(() =>
      parseRenderHostOutputRequest({
        type: "startMp4",
        jobId: "job",
        leaseId: "lease",
        outputId: "video",
        pixelFormat: "rgba",
        videoBitrateBps: 0,
      }),
    ).toThrow("bitrate");
    expect(() =>
      parseRenderHostOutputRequest({
        type: "writeMp4Audio",
        jobId: "job",
        leaseId: "lease",
        outputId: "video",
        samples: new ArrayBuffer(7),
      }),
    ).toThrow("Float32 stereo PCM");
  });
});
