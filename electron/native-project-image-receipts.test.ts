// @vitest-environment node
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, open, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import type { RenderJobManifest } from "../src/core/rendering/render-queue.js";
import {
  type NativeProjectExportExpectation,
  type NativeProjectExportReceipt,
  parseNativeProjectReceipt,
} from "./native-project-export-protocol.js";
import { readNativeProjectImages } from "./native-project-image-receipts.js";
import { AtomicRenderOutputPublisher } from "./render-queue-output.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(frames = 2) {
  const root = await mkdtemp(join(tmpdir(), "aster-image-receipts-"));
  roots.push(root);
  const source = join(root, "native"),
    path = `${source}.receipts.jsonl`;
  await mkdir(source);
  const expected: NativeProjectExportExpectation = {
    format: "png-sequence",
    projectSha256: "a".repeat(64),
    output: source,
    width: 2,
    height: 1,
    frameRate: { numerator: 30000, denominator: 1001 },
    startFrame: 17,
    frames,
    bitrate: 20000000,
    includeAudio: false,
  };
  const png = Buffer.alloc(32);
  Buffer.from("89504e470d0a1a0a", "hex").copy(png);
  png.write("IHDR", 12);
  png.writeUInt32BE(2, 16);
  png.writeUInt32BE(1, 20);
  const sha = createHash("sha256").update(png).digest("hex");
  const file = await open(path, "wx"),
    hash = createHash("sha256");
  let bytes = 0,
    batch = "";
  try {
    for (let index = 0; index < frames; index++) {
      const time = ((17 + index) * 1001) / 30000,
        bits = Buffer.alloc(8);
      bits.writeDoubleBE(time);
      const member = `frame_${String(index).padStart(6, "0")}.png`;
      batch += `${JSON.stringify({ index, member, time, time_bits: bits.toString("hex"), rgba_sha256: sha, png_sha256: sha, bytes: png.length })}\n`;
      if (frames <= 2) await writeFile(join(source, member), png);
      if (batch.length >= 32768 || index === frames - 1) {
        const data = Buffer.from(batch);
        await file.writeFile(data);
        hash.update(data);
        bytes += data.length;
        batch = "";
      }
    }
  } finally {
    await file.close();
  }
  const receipt: NativeProjectExportReceipt = parseNativeProjectReceipt(
    {
      schema_version: 1,
      status: "passed",
      format: expected.format,
      project: { authored_sha256: expected.projectSha256, runtime_sha256: "b".repeat(64) },
      size: { width: 2, height: 1 },
      frame_rate: expected.frameRate,
      output: source,
      report: { frames, elapsed_ms: 1 },
      image_receipts: { path, sha256: hash.digest("hex"), bytes, frames },
    },
    expected,
  );
  const manifest: RenderJobManifest = {
    id: "job",
    compositionId: "main",
    compositionName: "Main",
    projectRevision: 0,
    projectSnapshot: "{}",
    width: 2,
    height: 1,
    frameRate: expected.frameRate,
    startFrame: 17,
    endFrameExclusive: 17 + frames,
    priority: 0,
    createdAt: new Date().toISOString(),
    outputs: [
      {
        id: "sequence",
        kind: "pngSequence",
        destination: join(root, "published"),
        fileNamePattern: "shot_[######].png",
      },
    ],
  };
  return { root, path, source, expected, receipt, manifest };
}

async function consume(
  receipt: NativeProjectExportReceipt,
  expected: NativeProjectExportExpectation,
  cancelled?: () => boolean,
) {
  let count = 0;
  for await (const image of readNativeProjectImages(receipt, expected, cancelled)) {
    expect(image.index).toBe(count++);
  }
  return count;
}

test("streams more than the previous receipt limit without collecting image rows", async () => {
  const value = await fixture(70000);
  expect(value.receipt.images).toBeUndefined();
  expect(await consume(value.receipt, value.expected)).toBe(70000);
}, 20000);

test("rejects malformed, duplicated, truncated, changed and cancelled receipt streams", async () => {
  const value = await fixture(),
    original = await readFile(value.path);
  const lines = original.toString().trimEnd().split("\n");
  for (const data of [
    original.subarray(0, -1),
    Buffer.from(`${lines[0]}\n${lines[0]}\n`),
    Buffer.from(original.toString().replace('"rgba_sha256":"', '"rgba_sha256":"0')),
    Buffer.from(`${"x".repeat(1025)}\n`),
  ]) {
    await writeFile(value.path, data);
    const receipt = structuredClone(value.receipt);
    if (!receipt.image_receipts) throw new Error("Missing receipt file");
    receipt.image_receipts.bytes = data.length;
    await expect(consume(receipt, value.expected)).rejects.toThrow();
  }
  await writeFile(value.path, original);
  await expect(consume(value.receipt, value.expected, () => true)).rejects.toThrow("cancelled");
  const bad = structuredClone(value.receipt);
  if (!bad.image_receipts) throw new Error("Missing receipt file");
  bad.image_receipts.path = join(value.root, "elsewhere");
  expect(() => parseNativeProjectReceipt(bad, value.expected)).toThrow("differs");
  expect(() => parseNativeProjectReceipt({ ...value.receipt, images: [] }, value.expected)).toThrow(
    "differs",
  );
});

test("rechecks receipt and staged image bytes before atomic publication", async () => {
  const value = await fixture(),
    destination = value.manifest.outputs[0].destination;
  await mkdir(destination);
  await writeFile(join(destination, "owner.txt"), "owner");
  const original = await readFile(value.path),
    publisher = new AtomicRenderOutputPublisher(value.manifest, "stream");
  try {
    await publisher.prepare();
    const bad = structuredClone(value.receipt);
    if (!bad.image_receipts) throw new Error("Missing receipt file");
    bad.image_receipts.sha256 = "0".repeat(64);
    await expect(publisher.importNativeOutput("sequence", value.source, bad)).rejects.toThrow(
      "integrity",
    );
    // A rejected final hash removes previously staged copies, allowing a clean retry.
    await publisher.importNativeOutput("sequence", value.source, value.receipt);
    await writeFile(value.path, Buffer.alloc(original.length));
    await expect(publisher.publish()).rejects.toThrow();
    expect(await readFile(join(destination, "owner.txt"), "utf8")).toBe("owner");
    await writeFile(value.path, original);
    await publisher.publish();
    expect(await readFile(join(destination, "shot_000018.png"))).toEqual(
      await readFile(join(value.source, "frame_000000.png")),
    );
  } finally {
    await publisher.cleanup();
  }
});
