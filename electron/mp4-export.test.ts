// @vitest-environment node

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildExportArguments, selectEncoder, validateMp4ExportRequest } from "./mp4-export";

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
});
