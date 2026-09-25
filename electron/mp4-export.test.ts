// @vitest-environment node

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildExportArguments,
  Mp4ExportManager,
  removeStaleMp4ExportFiles,
  selectEncoder,
  validateMp4ExportRequest,
} from "./mp4-export";

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { force: true, recursive: true });
});

function outputPath(): string {
  const root = mkdtempSync(join(tmpdir(), "aster-mp4-validation-"));
  temporaryRoots.push(root);
  return join(root, "output.mp4");
}

describe("MP4 export validation", () => {
  const ffmpeg = process.env.ASTER_FFMPEG_PATH || "ffmpeg";
  it
    .skipIf(spawnSync(ffmpeg, ["-version"], { windowsHide: true }).status !== 0)
    .each(["rgba", "bgra"] as const)(
    "preserves saturated preview colors when encoding %s as limited-range BT.709",
    async (pixelFormat) => {
      const colors = [
        [13, 185, 148],
        [18, 217, 153],
        [12, 139, 142],
        [239, 246, 191],
        [24, 24, 24],
        [255, 255, 255],
      ];
      const width = colors.length * 64;
      const height = 64;
      const pixels = Buffer.alloc(width * height * 4);
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const color = colors[Math.floor(x / 64)];
          const offset = (y * width + x) * 4;
          pixels[offset] = color[pixelFormat === "rgba" ? 0 : 2];
          pixels[offset + 1] = color[1];
          pixels[offset + 2] = color[pixelFormat === "rgba" ? 2 : 0];
          pixels[offset + 3] = 255;
        }
      }
      const request = await validateMp4ExportRequest({
        outputPath: outputPath(),
        width,
        height,
        frameRateNumerator: 30,
        frameRateDenominator: 1,
        frameCount: 1,
        pixelFormat,
        videoBitrateBps: 20_000_000,
      });
      const encoded = spawnSync(
        ffmpeg,
        buildExportArguments(request, "libx264", request.outputPath),
        { input: pixels, windowsHide: true, timeout: 10_000 },
      );
      expect(encoded.status, encoded.stderr?.toString()).toBe(0);
      const decoded = spawnSync(
        ffmpeg,
        ["-v", "error", "-i", request.outputPath, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"],
        { windowsHide: true, timeout: 10_000 },
      );
      expect(decoded.status, decoded.stderr?.toString()).toBe(0);
      expect(decoded.stdout.length).toBe(width * height * 3);
      for (const [patch, color] of colors.entries()) {
        const offset = (32 * width + patch * 64 + 32) * 3;
        for (let channel = 0; channel < 3; channel++) {
          expect(Math.abs(decoded.stdout[offset + channel] - color[channel])).toBeLessThanOrEqual(
            3,
          );
        }
      }
    },
    25_000,
  );
  it.skipIf(spawnSync(ffmpeg, ["-version"], { windowsHide: true }).status !== 0)(
    "finishes a short real audiovisual export without waiting for more audio probe data",
    async () => {
      const manager = new Mp4ExportManager(ffmpeg);
      const path = outputPath();
      const job = await manager.start(
        {
          outputPath: path,
          width: 320,
          height: 180,
          frameRateNumerator: 10,
          frameRateDenominator: 1,
          frameCount: 10,
          pixelFormat: "rgba",
          videoBitrateBps: 1_000_000,
          audio: { sampleRate: 48_000, channels: 2, frameCount: 48_000 },
        },
        1,
      );
      const timeout = setTimeout(() => {
        void manager.dispose();
      }, 10_000);
      try {
        await Promise.all([
          (async () => {
            for (let frame = 0; frame < 10; frame++)
              await manager.write(job.jobId, new ArrayBuffer(320 * 180 * 4), 1);
          })(),
          (async () => {
            for (let chunk = 0; chunk < 10; chunk++)
              await manager.writeAudio(job.jobId, new ArrayBuffer(4800 * 8), 1);
          })(),
        ]);
        const result = await manager.finish(job.jobId, 1);
        expect(result.frameCount).toBe(10);
        expect(result.audioFrameCount).toBe(48_000);
        expect(existsSync(path)).toBe(true);
      } finally {
        clearTimeout(timeout);
        await manager.dispose();
      }
    },
    20_000,
  );
  it.skipIf(spawnSync(ffmpeg, ["-version"], { windowsHide: true }).status !== 0)(
    "rejects a backpressured audio write when the input is released",
    async () => {
      const manager = new Mp4ExportManager(ffmpeg);
      const job = await manager.start(
        {
          outputPath: outputPath(),
          width: 320,
          height: 180,
          frameRateNumerator: 10,
          frameRateDenominator: 1,
          frameCount: 100,
          pixelFormat: "rgba",
          videoBitrateBps: 1_000_000,
          audio: { sampleRate: 48_000, channels: 2, frameCount: 480_000 },
        },
        1,
      );
      try {
        // The stalled video input keeps FFmpeg from draining the PCM pipe, so these writes
        // pile up against its buffer the way a cancelled export leaves them.
        const writes = Array.from({ length: 80 }, () =>
          manager.writeAudio(job.jobId, new ArrayBuffer(4800 * 8), 1),
        );
        manager.releaseAudio(job.jobId, 1);
        const results = await Promise.allSettled(writes);
        expect(results.some((result) => result.status === "rejected")).toBe(true);
      } finally {
        await manager.dispose();
      }
    },
    20_000,
  );
  it("reports actionable setup guidance when FFmpeg is unavailable", async () => {
    await expect(selectEncoder(join(tmpdir(), "aster-missing-ffmpeg"))).rejects.toThrow(
      /Install FFmpeg, set ASTER_FFMPEG_PATH, or rebuild the application/,
    );
  });

  it("accepts a bounded rational-rate BGRA export", async () => {
    const request = await validateMp4ExportRequest({
      outputPath: outputPath(),
      width: 1_920,
      height: 1_080,
      frameRateNumerator: 60_000,
      frameRateDenominator: 1_001,
      frameCount: 120,
      pixelFormat: "bgra",
      videoBitrateBps: 20_000_000,
    });
    expect(request.frameBytes).toBe(1_920 * 1_080 * 4);
  });

  it("rejects odd dimensions and mismatched containers", async () => {
    const base = {
      outputPath: outputPath(),
      width: 1_920,
      height: 1_080,
      frameRateNumerator: 60,
      frameRateDenominator: 1,
      frameCount: 120,
      pixelFormat: "rgba",
      videoBitrateBps: 20_000_000,
    };
    await expect(validateMp4ExportRequest({ ...base, width: 1_919 })).rejects.toThrow(/even/);
    await expect(
      validateMp4ExportRequest({ ...base, outputPath: base.outputPath.replace(/mp4$/, "mov") }),
    ).rejects.toThrow(/\.mp4/);
    await expect(validateMp4ExportRequest({ ...base, videoBitrateBps: 0 })).rejects.toThrow(
      /video bitrate/,
    );
  });

  it("validates rationally aligned stereo PCM and configures an AAC pipe", async () => {
    const request = await validateMp4ExportRequest({
      outputPath: outputPath(),
      width: 1_920,
      height: 1_080,
      frameRateNumerator: 30_000,
      frameRateDenominator: 1_001,
      frameCount: 1_800,
      pixelFormat: "bgra",
      videoBitrateBps: 20_000_000,
      audio: { sampleRate: 48_000, channels: 2, frameCount: 2_882_880 },
    });
    const args = buildExportArguments(request, "libx264", request.outputPath);
    expect(args).toContain("pipe:3");
    expect(args).toContain("aac");
    expect(args).toContain("20000000");
    expect(request.audio?.frameCount).toBe(2_882_880);
    await expect(
      validateMp4ExportRequest({
        ...request,
        audio: { sampleRate: 48_000, channels: 2, frameCount: 2_882_879 },
      }),
    ).rejects.toThrow(/rational video duration/);
  });

  it("applies the requested bitrate to NVENC and libx264 rate control", async () => {
    const request = await validateMp4ExportRequest({
      outputPath: outputPath(),
      width: 3_840,
      height: 2_160,
      frameRateNumerator: 60,
      frameRateDenominator: 1,
      frameCount: 720,
      pixelFormat: "bgra",
      videoBitrateBps: 20_000_000,
    });
    for (const encoder of ["h264_nvenc", "libx264"] as const) {
      const args = buildExportArguments(request, encoder, request.outputPath);
      expect(args.slice(args.indexOf("-c:v"))).toEqual(
        expect.arrayContaining([
          "-b:v",
          "20000000",
          "-maxrate",
          "20000000",
          "-bufsize",
          "40000000",
        ]),
      );
      expect(args[args.indexOf("-b:v") + 1]).toBe("20000000");
      expect(args).not.toContain("-crf");
    }
  });

  it("removes only recognizable export temporaries from terminated processes", async () => {
    const root = mkdtempSync(join(tmpdir(), "aster-mp4-orphans-"));
    temporaryRoots.push(root);
    const stale = join(root, ".aster-export-111-123e4567-e89b-12d3-a456-426614174000.mp4");
    const active = join(root, ".aster-export-222-123e4567-e89b-12d3-a456-426614174001.mp4");
    const unrelated = join(root, ".aster-export-not-owned.mp4");
    for (const path of [stale, active, unrelated]) writeFileSync(path, "fixture");

    await removeStaleMp4ExportFiles(root, 222);

    expect(existsSync(stale)).toBe(false);
    expect(existsSync(active)).toBe(true);
    expect(existsSync(unrelated)).toBe(true);
  });
});
