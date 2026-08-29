import { describe, expect, it } from "vitest";
import { createBlankProject } from "../core/project";
import {
  appendRenderSequenceName,
  createRenderQueueJob,
  createRenderQueueJobAsync,
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
      outputKind: "pngSequence",
      destination: "C:\\renders\\Main-frames",
      range: "workArea",
      currentTime: 0,
    });
    expect(job).toMatchObject({
      startFrame: 30,
      endFrameExclusive: 120,
      frameRate: { numerator: 30_000, denominator: 1_001 },
      outputs: [{ kind: "pngSequence", fileNamePattern: "frame_[######].png" }],
    });
    expect(JSON.parse(job.projectSnapshot)).toMatchObject({ id: project.id, schemaVersion: 7 });
  });

  it("bounds a still to the current frame and rejects invalid H.264 dimensions", () => {
    const project = createBlankProject();
    const composition = project.compositions[0];
    const still = createRenderQueueJob({
      composition,
      project,
      projectRevision: 0,
      outputKind: "still",
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
        outputKind: "mp4",
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

  it("serializes large queue snapshots through the shared CPU scheduler", async () => {
    const project = createBlankProject();
    const job = await createRenderQueueJobAsync({
      composition: project.compositions[0],
      project,
      projectRevision: 2,
      outputKind: "still",
      destination: "C:\\renders\\frame.png",
      range: "currentFrame",
      currentTime: 0,
    });
    expect(job.projectSnapshot.endsWith("\n")).toBe(true);
    expect(JSON.parse(job.projectSnapshot)).toMatchObject({ id: project.id, schemaVersion: 7 });
  });
});
