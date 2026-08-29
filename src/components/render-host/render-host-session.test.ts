import { describe, expect, it, vi } from "vitest";
import { createLayerForComposition } from "../../core/layer-factory";
import { createBlankProject } from "../../core/project";
import type { RenderJobManifest } from "../../core/render-queue";
import type { Project } from "../../core/types";
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

function assignmentWithAudio(range = { start: 6, end: 8 }): {
  assignment: DesktopRenderHostAssignment;
  project: Project;
} {
  const work = assignment();
  const project = JSON.parse(work.manifest.projectSnapshot) as Project;
  const composition = project.compositions[0];
  const source = {
    id: "tone-source",
    kind: "audio" as const,
    name: "Tone.wav",
    mimeType: "audio/wav",
    contentIdentity: "sha256:tone",
    duration: composition.duration,
    channels: 1,
    sampleRate: 48_000,
    streamIndex: 0,
    interpretation: { alpha: "ignore" as const, colorSpace: "srgb" as const },
  };
  const layer = createLayerForComposition("audio", composition);
  layer.sourceId = source.id;
  project.sources = [source];
  composition.layers = [layer];
  work.manifest.projectSnapshot = JSON.stringify(project);
  work.manifest.startFrame = range.start;
  work.manifest.endFrameExclusive = range.end;
  work.manifest.outputs = [
    {
      id: "video",
      kind: "mp4",
      destination: "C:\\renders\\movie.mp4",
      codec: "h264",
      bitrateMbps: 16,
      includeAudio: true,
    },
  ];
  return { assignment: work, project };
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
      assignment: validateRenderHostAssignment(work),
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
      assignment: validateRenderHostAssignment(work),
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
      assignment: validateRenderHostAssignment(work),
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

  it("streams a bounded rationally aligned PCM range beside canonical beauty frames", async () => {
    const fixture = assignmentWithAudio();
    const validated = validateRenderHostAssignment(fixture.assignment);
    const samples = new Float32Array(96_000);
    samples[12_012] = 0.75;
    const decode = vi.fn(async () => ({ sampleRate: 48_000, channels: [samples] }));
    const outputs: DesktopRenderHostOutputRequest[] = [];
    const bytes = fixture.assignment.manifest.width * fixture.assignment.manifest.height * 4;

    const result = await runRenderHostFrameLoop({
      assignment: validated,
      pixelFormat: "rgba",
      audioDecoder: decode,
      requestedControl: () => undefined,
      renderFrame: async () => ({ pixels: new ArrayBuffer(bytes), pixelFormat: "rgba" }),
      encodePng: async () => new ArrayBuffer(8),
      output: async (request) => {
        outputs.push(request);
      },
      report: async () => undefined,
    });

    expect(result).toBe("completed");
    expect(decode).toHaveBeenCalledTimes(1);
    const start = outputs.find((output) => output.type === "startMp4");
    expect(start?.audio).toEqual({ sampleRate: 48_000, channels: 2, frameCount: 4_004 });
    const audio = outputs.find((output) => output.type === "writeMp4Audio");
    expect(audio?.samples.byteLength).toBe(4_004 * 2 * Float32Array.BYTES_PER_ELEMENT);
    expect(new Float32Array(audio?.samples ?? new ArrayBuffer(0)).slice(0, 4)).toEqual(
      new Float32Array([0.75, 0.75, 0, 0]),
    );
    expect(outputs.filter((output) => output.type === "writeMp4Frame")).toHaveLength(2);
    expect(outputs[outputs.length - 1]?.type).toBe("finishMp4");
  });

  it("omits a requested audio track when the immutable snapshot has no audible source", async () => {
    const work = assignment();
    const video = work.manifest.outputs[0];
    if (video.kind !== "mp4") throw new Error("fixture mismatch");
    work.manifest.outputs = [{ ...video, includeAudio: true }];
    const decode = vi.fn();
    const outputs: DesktopRenderHostOutputRequest[] = [];
    const validated = validateRenderHostAssignment(work);

    await runRenderHostFrameLoop({
      assignment: validated,
      pixelFormat: "rgba",
      audioDecoder: decode,
      requestedControl: () => undefined,
      renderFrame: async () => ({
        pixels: new ArrayBuffer(work.manifest.width * work.manifest.height * 4),
        pixelFormat: "rgba",
      }),
      encodePng: async () => new ArrayBuffer(8),
      output: async (request) => {
        outputs.push(request);
      },
      report: async () => undefined,
    });

    expect(decode).not.toHaveBeenCalled();
    expect(outputs.find((output) => output.type === "startMp4")?.audio).toBeUndefined();
    expect(outputs.some((output) => output.type === "writeMp4Audio")).toBe(false);
  });

  it("fails before opening encoders when immutable-source audio decode fails", async () => {
    const fixture = assignmentWithAudio();
    const output = vi.fn();

    await expect(
      runRenderHostFrameLoop({
        assignment: validateRenderHostAssignment(fixture.assignment),
        pixelFormat: "rgba",
        audioDecoder: async () => {
          throw new Error("codec unavailable");
        },
        requestedControl: () => undefined,
        renderFrame: async () => ({ pixels: new ArrayBuffer(64 * 64 * 4), pixelFormat: "rgba" }),
        encodePng: async () => new ArrayBuffer(8),
        output,
        report: async () => undefined,
      }),
    ).rejects.toThrow("codec unavailable");
    expect(output).not.toHaveBeenCalled();
  });

  it("stops PCM chunks at a cancel boundary and leaves the MP4 unfinished for rollback", async () => {
    const fixture = assignmentWithAudio({ start: 0, end: 48 });
    const composition = fixture.project.compositions[0];
    composition.duration = 3;
    composition.workArea = { start: 0, end: 3 };
    composition.layers[0].outPoint = 3;
    const source = fixture.project.sources[0];
    if (!source || (source.kind !== "audio" && source.kind !== "video"))
      throw new Error("fixture mismatch");
    source.duration = 3;
    fixture.assignment.manifest.projectSnapshot = JSON.stringify(fixture.project);
    const decode = vi.fn(async () => ({
      sampleRate: 48_000,
      channels: [new Float32Array(144_000)],
    }));
    let control: "cancel" | undefined;
    const outputs: DesktopRenderHostOutputRequest[] = [];
    const reports: DesktopRenderHostReport[] = [];
    const validated = validateRenderHostAssignment(fixture.assignment);

    const result = await runRenderHostFrameLoop({
      assignment: validated,
      pixelFormat: "rgba",
      audioDecoder: decode,
      requestedControl: () => control,
      renderFrame: async () => ({
        pixels: new ArrayBuffer(
          fixture.assignment.manifest.width * fixture.assignment.manifest.height * 4,
        ),
        pixelFormat: "rgba",
      }),
      encodePng: async () => new ArrayBuffer(8),
      output: async (request) => {
        outputs.push(request);
        if (request.type === "writeMp4Audio") control = "cancel";
      },
      report: async (report) => {
        reports.push(report);
      },
    });

    expect(result).toBe("cancelled");
    expect(outputs.filter((output) => output.type === "writeMp4Audio")).toHaveLength(1);
    expect(outputs.some((output) => output.type === "finishMp4")).toBe(false);
    expect(reports[reports.length - 1]?.type).toBe("cancelled");
  });
});
