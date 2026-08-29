// @vitest-environment node

import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { RenderJobManifest } from "../src/core/render-queue";
import { AtomicRenderOutputPublisher } from "./render-queue-output";

const roots: string[] = [];
const png = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]).buffer;

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function context(): Promise<{ root: string; manifest: RenderJobManifest }> {
  const root = await mkdtemp(join(tmpdir(), "aster-render-output-"));
  roots.push(root);
  return {
    root,
    manifest: {
      id: "job",
      compositionId: "composition",
      compositionName: "Main",
      projectRevision: 1,
      projectSnapshot: "{}",
      width: 64,
      height: 64,
      frameRate: { numerator: 30_000, denominator: 1_001 },
      startFrame: 10,
      endFrameExclusive: 12,
      priority: 1,
      createdAt: "2026-01-01T00:00:00.000Z",
      outputs: [
        {
          id: "sequence",
          kind: "pngSequence",
          destination: join(root, "sequence"),
          fileNamePattern: "frame_[######].png",
        },
        {
          id: "still",
          kind: "still",
          destination: join(root, "poster.png"),
          format: "png",
          frame: 10,
        },
        {
          id: "video",
          kind: "mp4",
          destination: join(root, "movie.mp4"),
          codec: "h264",
          bitrateMbps: 16,
          includeAudio: false,
        },
      ],
    },
  };
}

describe("atomic render output publisher", () => {
  it("publishes still, sequence, and MP4 only after every staged module completes", async () => {
    const { root, manifest } = await context();
    const publisher = new AtomicRenderOutputPublisher(manifest, "lease");
    await publisher.prepare();
    await publisher.writePng("sequence", 10, png.slice(0));
    await publisher.writePng("sequence", 11, png.slice(0));
    await publisher.writePng("still", 10, png.slice(0));
    await writeFile(publisher.mp4StagingPath("video"), "video");

    await publisher.publish();

    expect(await readFile(join(root, "poster.png"))).toEqual(Buffer.from(png));
    expect(await readFile(join(root, "sequence", "frame_000011.png"))).toEqual(Buffer.from(png));
    expect(await readFile(join(root, "sequence", "frame_000012.png"))).toEqual(Buffer.from(png));
    expect(await readFile(join(root, "movie.mp4"), "utf8")).toBe("video");
  });

  it("does not replace existing destinations when a staged module is incomplete", async () => {
    const { root, manifest } = await context();
    await writeFile(join(root, "poster.png"), "original");
    const publisher = new AtomicRenderOutputPublisher(manifest, "lease");
    await publisher.prepare();
    await publisher.writePng("still", 10, png.slice(0));

    await expect(publisher.publish()).rejects.toThrow("sequence");
    expect(await readFile(join(root, "poster.png"), "utf8")).toBe("original");
    await publisher.cleanup();
    await expect(stat(publisher.mp4StagingPath("video"))).rejects.toThrow();
  });

  it("restores earlier destinations when a later atomic publish precondition fails", async () => {
    const { root, manifest } = await context();
    await writeFile(join(root, "poster.png"), "original");
    await mkdir(join(root, "movie.mp4"));
    const publisher = new AtomicRenderOutputPublisher(manifest, "lease");
    await publisher.prepare();
    await publisher.writePng("sequence", 10, png.slice(0));
    await publisher.writePng("sequence", 11, png.slice(0));
    await publisher.writePng("still", 10, png.slice(0));
    await writeFile(publisher.mp4StagingPath("video"), "video");

    await expect(publisher.publish()).rejects.toThrow("incompatible type");
    expect(await readFile(join(root, "poster.png"), "utf8")).toBe("original");
  });

  it("rolls back a cancellation that arrives during the atomic rename phase", async () => {
    const { root, manifest } = await context();
    const still = manifest.outputs[1];
    if (still.kind !== "still") throw new Error("fixture mismatch");
    const publisher = new AtomicRenderOutputPublisher({ ...manifest, outputs: [still] }, "lease");
    await writeFile(join(root, "poster.png"), "original");
    await publisher.prepare();
    await publisher.writePng("still", 10, png.slice(0));
    let checkpoints = 0;

    await expect(publisher.publish(() => ++checkpoints >= 5)).rejects.toThrow("cancelled");
    expect(await readFile(join(root, "poster.png"), "utf8")).toBe("original");
  });

  it("rejects traversal patterns and unsupported output modes", async () => {
    const { manifest } = await context();
    const sequence = manifest.outputs[0];
    if (sequence.kind !== "pngSequence") throw new Error("fixture mismatch");
    expect(
      () =>
        new AtomicRenderOutputPublisher(
          { ...manifest, outputs: [{ ...sequence, fileNamePattern: "../frame.png" }] },
          "lease",
        ),
    ).toThrow("plain .png");
    const video = manifest.outputs[2];
    if (video.kind !== "mp4") throw new Error("fixture mismatch");
    expect(
      () =>
        new AtomicRenderOutputPublisher(
          { ...manifest, outputs: [{ ...video, includeAudio: true }] },
          "lease",
        ),
    ).not.toThrow();
    expect(
      () =>
        new AtomicRenderOutputPublisher(
          { ...manifest, outputs: [{ ...video, codec: "h265" }] },
          "lease",
        ),
    ).toThrow("H.264");
  });
});
