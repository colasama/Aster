// @vitest-environment node
import { beforeEach, expect, it, vi } from "vitest";
import type { NativeEncodedSpool } from "./native-encoded-spool";
import { NativeExportSession } from "./native-export-session";
import type { NativeRenderClient } from "./native-render-client";
import type { NativeSessionCommand } from "./native-render-protocol";

const mux = vi.hoisted(() => ({
  start: vi.fn(async () => ({ jobId: "mux" })),
  writeAudio: vi.fn(),
  writeEncoded: vi.fn(),
  finish: vi.fn(async () => ({ frameCount: 1 })),
  dispose: vi.fn(async () => {}),
}));
vi.mock("./mp4-export.js", () => ({
  Mp4ExportManager: class {
    start = mux.start;
    writeAudio = mux.writeAudio;
    writeEncoded = mux.writeEncoded;
    finish = mux.finish;
    dispose = mux.dispose;
  },
  validateMp4ExportRequest: async (value: unknown) => value,
}));
beforeEach(() => vi.clearAllMocks());

it.each([true, false])("drains video before waiting for PCM, valid drain=%s", async (valid) => {
  let releaseAudio: (() => void) | undefined;
  mux.writeAudio.mockImplementation(
    () =>
      new Promise<void>((done) => {
        releaseAudio = done;
      }),
  );
  mux.writeEncoded.mockImplementation(async () => releaseAudio?.());
  const client = {
    request: vi.fn(async (command: NativeSessionCommand) => ({
      version: 1 as const,
      request_id: 1,
      payload_bytes: 6,
      payload: Buffer.alloc(6),
      response:
        command.type === "begin_export"
          ? {
              type: "export_started",
              frame_count: 1,
              video: command.video,
              transport: "nv12-shared",
              transport_reason: null,
            }
          : {
              type: "encoded",
              packets:
                command.type === "render_frame"
                  ? []
                  : [
                      {
                        frame_index: 0,
                        timestamp_100ns: 0,
                        duration_100ns: 333333,
                        payload_bytes: 6,
                      },
                    ],
              encoder: {
                drain_completed: valid,
                accepted_frames: 1,
                encoded_frames: 1,
                cancelled: false,
              },
            },
    })),
    shutdown: vi.fn(async () => {}),
    dispose: vi.fn(async () => {}),
  };
  const session = await NativeExportSession.start(
    client as unknown as NativeRenderClient,
    "ffmpeg",
    {
      outputPath: "output.mp4",
      width: 320,
      height: 180,
      frameCount: 1,
      frameRateNumerator: 30,
      frameRateDenominator: 1,
      pixelFormat: "rgba",
      videoBitrateBps: 8000000,
      audio: { sampleRate: 48000, channels: 2, frameCount: 1600 },
    },
  );
  const audio = session.writeAudio(new ArrayBuffer(1600 * 8));
  const video = session.render(new Uint8Array(1));
  if (valid) {
    await video;
    await audio;
    expect(client.shutdown).toHaveBeenCalledOnce();
    expect(mux.finish).not.toHaveBeenCalled();
    await session.finish();
    expect(mux.finish).toHaveBeenCalledOnce();
  } else {
    await expect(video).rejects.toThrow("did not drain");
    await audio;
    expect(mux.dispose).toHaveBeenCalledOnce();
    await expect(session.finish()).rejects.toThrow("closed");
    expect(mux.finish).not.toHaveBeenCalled();
  }
  expect(client.request.mock.calls.map(([command]) => command.type)).toEqual([
    "begin_export",
    "render_frame",
    "finish_export",
  ]);
});

it("replays admitted compressed packets and the drain without another native decode/render", async () => {
  const client = { request: vi.fn(), shutdown: vi.fn(), dispose: vi.fn() };
  const stored = {
    statistics: { sealed: true, frames: 1 },
    read: vi.fn(async (frame: number) => ({
      payload: Buffer.from([0, 0, 0, 1, 101, 23]),
      response: {
        packets:
          frame === 0
            ? []
            : [{ frame_index: 0, timestamp_100ns: 0, duration_100ns: 333333, payload_bytes: 6 }],
        encoder: { drain_completed: true, accepted_frames: 1, encoded_frames: 1, cancelled: false },
      },
    })),
  };
  mux.writeEncoded.mockResolvedValue(undefined);
  const session = await NativeExportSession.start(
    client as unknown as NativeRenderClient,
    "ffmpeg",
    {
      outputPath: "output.mp4",
      width: 320,
      height: 180,
      frameCount: 1,
      frameRateNumerator: 30,
      frameRateDenominator: 1,
      pixelFormat: "rgba",
      videoBitrateBps: 8000000,
    },
    {
      version: 1,
      request_id: 1,
      payload_bytes: 0,
      payload: Buffer.alloc(0),
      response: {
        type: "export_started",
        frame_count: 1,
        video: {
          size: { width: 320, height: 180 },
          frame_rate: { numerator: 30, denominator: 1 },
          bitrate_bps: 8000000,
        },
        transport: "nv12-shared",
        transport_reason: null,
      },
    },
    stored as unknown as NativeEncodedSpool,
  );
  await expect(session.render(new Uint8Array(1))).rejects.toThrow(/transport/);
  await session.render();
  await session.finish();
  expect(stored.read.mock.calls.map(([frame]) => frame)).toEqual([0, 1]);
  expect(client.request).not.toHaveBeenCalled();
  expect(client.shutdown).not.toHaveBeenCalled();
  expect(mux.writeEncoded).toHaveBeenCalledOnce();
  expect(mux.finish).toHaveBeenCalledOnce();
});
