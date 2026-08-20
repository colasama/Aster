import { describe, expect, it } from "vitest";
import { streamFramePipeline } from "./render-export";

describe("MP4 frame pipeline", () => {
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
});
