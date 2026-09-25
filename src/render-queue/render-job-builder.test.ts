import { describe, expect, it } from "vitest";
import { createBlankProject } from "../core/project/project";
import {
  appendRenderSequenceName,
  createRenderQueueJob,
  createRenderQueueJobAsync,
  isValidSequencePattern,
} from "./render-job-builder";

describe("render job builder", () => {
  it("captures an immutable rational-frame work area", () => {
    const project = createBlankProject();
    const composition = project.compositions[0];
    composition.frameRate = { numerator: 30_000, denominator: 1_001 };
    composition.duration = 10;
    composition.workArea = { start: 1.001, end: 4.004 };
    const job = createRenderQueueJob({
      composition,
      project,
      projectRevision: 9,
      antiAliasing: "fxaa",
      output: { kind: "pngSequence", fileNamePattern: "frame_[######].png" },
      destination: "C:\\renders\\Main-frames",
      range: "workArea",
      currentTime: 0,
    });
    expect(job).toMatchObject({
      antiAliasing: "fxaa",
      startFrame: 30,
      endFrameExclusive: 120,
      frameRate: { numerator: 30_000, denominator: 1_001 },
      outputs: [{ kind: "pngSequence", fileNamePattern: "frame_[######].png" }],
    });
    expect(JSON.parse(job.projectSnapshot)).toMatchObject({ id: project.id, schemaVersion: 10 });
  });

  it("bounds a still to the current frame and rejects invalid H.264 dimensions", () => {
    const project = createBlankProject();
    const composition = project.compositions[0];
    const still = createRenderQueueJob({
      composition,
      project,
      projectRevision: 0,
      output: { kind: "still", format: "png" },
      destination: "C:\\renders\\frame.png",
      range: "currentFrame",
      currentTime: 1.25,
    });
    expect(still.endFrameExclusive - still.startFrame).toBe(1);
    expect(still.outputs[0]).toMatchObject({ kind: "still", frame: still.startFrame });
    composition.width = 1919;
    expect(() =>
      createRenderQueueJob({
        composition,
        project,
        projectRevision: 0,
        output: { kind: "mp4", bitrateMbps: 20, includeAudio: false },
        destination: "C:\\renders\\video.mp4",
        range: "composition",
        currentTime: 0,
      }),
    ).toThrow("dimensions must be even");
  });

  it("builds a filesystem-safe sequence destination on either path style", () => {
    expect(appendRenderSequenceName("C:\\renders\\", 'Main: "Cut"')).toBe(
      "C:\\renders\\Main- -Cut--frames",
    );
    expect(appendRenderSequenceName("/renders", "Main/Cut")).toBe("/renders/Main-Cut-frames");
  });

  it("maps output module options onto the immutable manifest", () => {
    const project = createBlankProject();
    const composition = project.compositions[0];
    const job = createRenderQueueJob({
      composition,
      project,
      projectRevision: 0,
      output: { kind: "mp4", bitrateMbps: 48, includeAudio: true },
      destination: "C:\\renders\\video.mp4",
      range: "composition",
      currentTime: 0,
    });
    expect(job.outputs[0]).toMatchObject({
      kind: "mp4",
      codec: "h264",
      bitrateMbps: 48,
      includeAudio: true,
    });
    const sequence = createRenderQueueJob({
      composition,
      project,
      projectRevision: 0,
      output: { kind: "pngSequence", fileNamePattern: "shot_[##].png" },
      destination: "C:\\renders\\frames",
      range: "custom",
      customRange: { start: 1, end: 3 },
      currentTime: 0,
    });
    expect(sequence.startFrame).toBe(
      Math.round(composition.frameRate.numerator / composition.frameRate.denominator),
    );
    expect(sequence.outputs[0]).toMatchObject({ fileNamePattern: "shot_[##].png" });
  });

  it("clamps custom ranges to the composition and bounds bitrates", () => {
    const project = createBlankProject();
    const composition = project.compositions[0];
    composition.duration = 10;
    composition.frameRate = { numerator: 30, denominator: 1 };
    const job = createRenderQueueJob({
      composition,
      project,
      projectRevision: 0,
      output: { kind: "mp4", bitrateMbps: 5_000, includeAudio: false },
      destination: "C:\\renders\\video.mp4",
      range: "custom",
      customRange: { start: -5, end: 60 },
      currentTime: 0,
    });
    expect(job.startFrame).toBe(0);
    expect(job.endFrameExclusive).toBe(300);
    expect(job.outputs[0]).toMatchObject({ bitrateMbps: 1_000 });
    expect(() =>
      createRenderQueueJob({
        composition,
        project,
        projectRevision: 0,
        output: { kind: "pngSequence", fileNamePattern: "nested/frame.png" },
        destination: "C:\\renders\\frames",
        range: "workArea",
        currentTime: 0,
      }),
    ).toThrow("plain .png file name");
  });

  it("validates sequence patterns the same way the publisher does", () => {
    expect(isValidSequencePattern("frame_[######].png")).toBe(true);
    expect(isValidSequencePattern("plain.png")).toBe(true);
    expect(isValidSequencePattern("nested/frame.png")).toBe(false);
    expect(isValidSequencePattern("..\\frame.png")).toBe(false);
    expect(isValidSequencePattern("frame.exr")).toBe(false);
    expect(isValidSequencePattern("frame_[##]_[##].png")).toBe(false);
    expect(isValidSequencePattern("   ")).toBe(false);
  });

  it("serializes large queue snapshots through the shared CPU scheduler", async () => {
    const project = createBlankProject();
    const job = await createRenderQueueJobAsync({
      composition: project.compositions[0],
      project,
      projectRevision: 2,
      output: { kind: "still", format: "png" },
      destination: "C:\\renders\\frame.png",
      range: "currentFrame",
      currentTime: 0,
    });
    expect(job.projectSnapshot.endsWith("\n")).toBe(true);
    expect(JSON.parse(job.projectSnapshot)).toMatchObject({ id: project.id, schemaVersion: 10 });
  });
});
