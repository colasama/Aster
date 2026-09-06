import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { localMediaPath, ReferenceMediaService, runMediaProcess } from "./reference-media";

const ffmpeg = process.env.ASTER_FFMPEG_PATH || "ffmpeg";
const ffprobe = process.env.ASTER_FFPROBE_PATH || "ffprobe";
const available = [ffmpeg, ffprobe].every(
  (binary) => spawnSync(binary, ["-version"], { windowsHide: true }).status === 0,
);

describe("reference media decoder", () => {
  it("rejects URLs and cancels a running decoder with bounded output", async () => {
    await expect(localMediaPath("https://example.com/reference.mp4")).rejects.toThrow("absolute");
    await expect(
      runMediaProcess(
        process.execPath,
        ["-e", "process.stdout.write('x'.repeat(10000))"],
        new AbortController().signal,
        100,
      ),
    ).rejects.toThrow("budget");
    const controller = new AbortController();
    const pending = runMediaProcess(
      process.execPath,
      ["-e", "setTimeout(()=>{},10000)"],
      controller.signal,
    );
    controller.abort();
    await expect(pending).rejects.toThrow("cancelled");
  });

  it.skipIf(!available)(
    "probes real media, reports the selected frame timestamp, and reads bounded audio",
    async () => {
      const directory = await mkdtemp(join(tmpdir(), "aster-reference-test-"));
      try {
        const path = join(directory, "reference with spaces.mp4");
        const signal = new AbortController().signal;
        await runMediaProcess(
          ffmpeg,
          [
            "-v",
            "error",
            "-f",
            "lavfi",
            "-i",
            "testsrc2=size=160x90:rate=10",
            "-f",
            "lavfi",
            "-i",
            "sine=frequency=440:sample_rate=16000",
            "-t",
            "1",
            "-c:v",
            "libx264",
            "-pix_fmt",
            "yuv420p",
            "-c:a",
            "aac",
            path,
          ],
          signal,
        );
        const service = new ReferenceMediaService(ffmpeg, ffprobe);
        const probe = await service.probe(path, signal);
        expect(
          probe.streams.some((stream: { codec_type: string }) => stream.codec_type === "audio"),
        ).toBe(true);
        const frames = await service.frames({ path, times: [0, 0.15], maxDimension: 160 }, signal);
        expect(frames.frames.map((frame) => frame.actualTime)).toEqual([0, 0.2]);
        expect(frames.frames[0]).toMatchObject({ width: 160, height: 90, mimeType: "image/png" });
        const audio = await service.audio({ path, start: 0.1, duration: 0.2 }, signal);
        expect(Buffer.from(audio.audio.data, "base64").subarray(0, 4).toString()).toBe("RIFF");
        await expect(service.frames({ path, times: [3] }, signal)).rejects.toThrow(
          "No video frame",
        );
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
    30_000,
  );
});
