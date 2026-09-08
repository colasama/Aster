import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createRenderQueue, enqueueRenderJob } from "../src/core/rendering/render-queue";
import {
  isRenderDestinationAuthorized,
  ownedRenderOutputPath,
  renderPathKey,
} from "./render-queue-paths";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function job(destination: string) {
  return {
    id: "job",
    compositionId: "composition",
    compositionName: "Main",
    projectRevision: 1,
    projectSnapshot: '{"schemaVersion":5}',
    width: 1920,
    height: 1080,
    frameRate: { numerator: 30, denominator: 1 },
    startFrame: 0,
    endFrameExclusive: 30,
    outputs: [
      {
        id: "sequence",
        kind: "pngSequence" as const,
        destination,
        fileNamePattern: "frame_[######].png",
      },
    ],
  };
}

describe("render queue paths", () => {
  it("authorizes an exact picker path and one direct sequence child only", async () => {
    const root = await mkdtemp(join(tmpdir(), "aster-render-paths-"));
    roots.push(root);
    const grants = new Set([renderPathKey(root)]);
    expect(isRenderDestinationAuthorized(join(root, "Main-frames"), grants)).toBe(true);
    expect(isRenderDestinationAuthorized(join(root, "nested", "Main-frames"), grants)).toBe(false);
    expect(isRenderDestinationAuthorized(join(root, "video.mp4"), new Set())).toBe(false);
    const file = join(root, "video.mp4");
    expect(isRenderDestinationAuthorized(file, new Set([renderPathKey(file)]))).toBe(true);
  });

  it("reveals only a bounded output path present in the process queue", () => {
    const destination = join(tmpdir(), "aster-owned-output.mp4");
    const queue = enqueueRenderJob(createRenderQueue(), {
      ...job(destination),
      outputs: [
        {
          id: "video",
          kind: "mp4",
          destination,
          codec: "h264",
          bitrateMbps: 20,
          includeAudio: false,
        },
      ],
    });
    expect(ownedRenderOutputPath(queue, destination)).toBe(destination);
    expect(() => ownedRenderOutputPath(queue, join(tmpdir(), "other.mp4"))).toThrow("not owned");
    expect(() => ownedRenderOutputPath(queue, "x".repeat(4_097))).toThrow("invalid");
  });
});
