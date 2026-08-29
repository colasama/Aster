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
  });
});
