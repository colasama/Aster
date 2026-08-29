import { describe, expect, it } from "vitest";
import { createBlankProject } from "../../core/project";
import type { RenderJobManifest } from "../../core/render-queue";
import type {
  DesktopRenderHostAssignment,
  DesktopRenderHostOutputRequest,
  DesktopRenderHostReport,
} from "../../desktop/api";
import {
  mergeRenderHostControl,
  runRenderHostFrameLoop,
  validateRenderHostAssignment,
} from "./render-host-session";

function assignment(): DesktopRenderHostAssignment {
  const project = createBlankProject();
  const composition = project.compositions[0];
  composition.width = 64;
  composition.height = 64;
  composition.duration = 2;
  composition.workArea = { start: 0, end: 2 };
  for (const layer of composition.layers) layer.outPoint = 2;
  composition.frameRate = { numerator: 24_000, denominator: 1_001 };
  const manifest: RenderJobManifest = {
    id: "job",
    compositionId: composition.id,
    compositionName: composition.name,
    projectRevision: 3,
    projectSnapshot: JSON.stringify(project),
    width: composition.width,
    height: composition.height,
    frameRate: composition.frameRate,
    startFrame: 0,
    endFrameExclusive: 2,
    priority: 1,
    createdAt: "2026-08-30T00:00:00.000Z",
    outputs: [
      {
        id: "video",
        kind: "mp4",
        destination: "C:\\renders\\movie.mp4",
        codec: "h264",
        bitrateMbps: 16,
        includeAudio: false,
      },
      {
        id: "sequence",
        kind: "pngSequence",
        destination: "C:\\renders\\sequence",
        fileNamePattern: "frame_[######].png",
      },
      {
        id: "still",
        kind: "still",
        destination: "C:\\renders\\still.png",
        format: "png",
        frame: 1,
      },
    ],
  };
  return { jobId: manifest.id, leaseId: "lease", manifest };
}

describe("RenderHost frame session", () => {
  it("uses rational time and fans one canonical beauty frame into every output", async () => {
    const work = assignment();
    const outputs: DesktopRenderHostOutputRequest[] = [];
    const reports: DesktopRenderHostReport[] = [];
    const renderTimes: number[] = [];
    const bytes = work.manifest.width * work.manifest.height * 4;
    let clock = 0;

    const result = await runRenderHostFrameLoop({
      assignment: work,
      pixelFormat: "bgra",
      requestedControl: () => undefined,
      now: () => clock++,
      renderFrame: async (frame, time) => {
        renderTimes.push(time);
        return { pixels: new Uint8Array(bytes).fill(frame + 1).buffer, pixelFormat: "bgra" };
      },
      encodePng: async (frame) => frame.pixels.slice(0, 8),
      output: async (request) => {
        outputs.push(request);
      },
      report: async (report) => {
        reports.push(report);
      },
    });

    expect(result).toBe("completed");
    expect(renderTimes).toEqual([0, 1_001 / 24_000]);
    expect(outputs.map((output) => output.type)).toEqual([
      "startMp4",
      "writePng",
      "writeMp4Frame",
      "writePng",
      "writePng",
      "writeMp4Frame",
      "finishMp4",
    ]);
    const videoFrames = outputs.filter((output) => output.type === "writeMp4Frame");
    expect(new Uint8Array(videoFrames[0]?.pixels ?? new ArrayBuffer(0))[0]).toBe(1);
    expect(new Uint8Array(videoFrames[1]?.pixels ?? new ArrayBuffer(0))[0]).toBe(2);
    expect(reports.map((report) => report.type)).toEqual([
      "prepared",
      "progress",
      "progress",
      "completed",
    ]);
  });

  it("acknowledges cancel only after the current frame output boundary", async () => {
    const work = assignment();
    work.manifest.outputs = [work.manifest.outputs[0]];
    const reports: DesktopRenderHostReport[] = [];
    let control: "cancel" | undefined;
    let rendered = 0;

    const result = await runRenderHostFrameLoop({
      assignment: work,
      pixelFormat: "rgba",
      requestedControl: () => control,
      renderFrame: async () => {
        rendered += 1;
        return {
          pixels: new ArrayBuffer(work.manifest.width * work.manifest.height * 4),
          pixelFormat: "rgba",
        };
      },
      encodePng: async () => new ArrayBuffer(8),
      output: async (request) => {
        if (request.type === "writeMp4Frame") control = "cancel";
      },
      report: async (report) => {
        reports.push(report);
      },
    });

    expect(result).toBe("cancelled");
    expect(rendered).toBe(1);
    expect(reports.map((report) => report.type)).toEqual(["prepared", "progress", "cancelled"]);
  });

  it("validates snapshot parity and keeps cancel dominant over pause", () => {
    const work = assignment();
    expect(validateRenderHostAssignment(work)).toMatchObject({ synchronizeVideo: false });
    expect(
      mergeRenderHostControl(
        "pause",
        { jobId: work.jobId, leaseId: work.leaseId, command: "cancel" },
        work,
      ),
    ).toBe("cancel");
    expect(() =>
      validateRenderHostAssignment({
        ...work,
        manifest: { ...work.manifest, width: work.manifest.width + 1 },
      }),
    ).toThrow("dimensions");
  });

  it("honors a control received while the final encoder is flushing", async () => {
    const work = assignment();
    work.manifest.endFrameExclusive = 1;
    work.manifest.outputs = [work.manifest.outputs[0]];
    let control: "pause" | undefined;
    const reports: DesktopRenderHostReport[] = [];

    const result = await runRenderHostFrameLoop({
      assignment: work,
      pixelFormat: "rgba",
      requestedControl: () => control,
      renderFrame: async () => ({
        pixels: new ArrayBuffer(work.manifest.width * work.manifest.height * 4),
        pixelFormat: "rgba",
      }),
      encodePng: async () => new ArrayBuffer(8),
      output: async (request) => {
        if (request.type === "finishMp4") control = "pause";
      },
      report: async (report) => {
        reports.push(report);
      },
    });

    expect(result).toBe("paused");
    expect(reports.map((report) => report.type)).toEqual(["prepared", "progress", "paused"]);
  });
});
