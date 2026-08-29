// @vitest-environment node

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildExportArguments, validateMp4ExportRequest } from "./mp4-export";

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
  it("accepts a bounded rational-rate BGRA export", async () => {
    const request = await validateMp4ExportRequest({
      outputPath: outputPath(),
      width: 1_920,
      height: 1_080,
      frameRateNumerator: 60_000,
      frameRateDenominator: 1_001,
      frameCount: 120,
      pixelFormat: "bgra",
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
    };
    await expect(validateMp4ExportRequest({ ...base, width: 1_919 })).rejects.toThrow(/even/);
    await expect(
      validateMp4ExportRequest({ ...base, outputPath: base.outputPath.replace(/mp4$/, "mov") }),
    ).rejects.toThrow(/\.mp4/);
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
      audio: { sampleRate: 48_000, channels: 2, frameCount: 2_882_880 },
    });
    const args = buildExportArguments(request, "libx264", request.outputPath);
    expect(args).toContain("pipe:3");
    expect(args).toContain("aac");
    expect(request.audio?.frameCount).toBe(2_882_880);
    await expect(
      validateMp4ExportRequest({
        ...request,
        audio: { sampleRate: 48_000, channels: 2, frameCount: 2_882_879 },
      }),
    ).rejects.toThrow(/rational video duration/);
  });
});
