import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { validateFrameResource } from "../parity/frame-artifacts.mjs";
import { encodeRgbaPng } from "../parity/png.mjs";
import { writeAtomicJson } from "./report.mjs";
import { sourceProvenance } from "./source.mjs";

/** Save independent-device production replay inputs before native comparison is invoked. */
export async function captureTemporalFrames(config, cases) {
  const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
  const local = (path) => relative(config.root, path).replaceAll("\\", "/");
  const report = { schema_version: 1, source: await sourceProvenance(config.root), frames: [] };
  assert.deepEqual(
    cases.map((c) => c.mode),
    ["full", "enters", "exits", "recursive", "recursive-effects"],
  );
  for (const item of cases) {
    assert.equal(item.frames.length, 2);
    const resources = join(config.output, "frames", item.mode, "frame-resources");
    await mkdir(resources, { recursive: true });
    const known = new Set();
    for (const [index, frame] of item.frames.entries()) {
      assert(
        frame.exact && frame.independent_device && frame.warmed_cache && frame.changed_pixels > 16,
      );
      const { capture, ...proof } = frame;
      assert(capture);
      const dir = join(config.output, "frames", item.mode, String(index));
      await mkdir(dir, { recursive: true });
      const plan = Buffer.from(capture.plan),
        pixels = Buffer.from(capture.rgba);
      assert.equal(pixels.length, 320 * 180 * 4);
      const png = encodeRgbaPng(320, 180, pixels);
      await writeFile(join(dir, "replay.fpln"), plan, { flag: "wx" });
      await writeFile(join(dir, "frame.png"), png, { flag: "wx" });
      const records = [];
      for (const packet of capture.resources) {
        const bytes = Buffer.from(packet.bytes);
        validateFrameResource(packet.message, bytes);
        if (!known.has(packet.message.hash)) {
          await writeFile(join(resources, `${packet.message.hash}.bin`), bytes, { flag: "wx" });
          known.add(packet.message.hash);
        }
        records.push({ message: packet.message, sha256: sha(bytes) });
      }
      await writeAtomicJson(
        join(dir, "resources.json"),
        records.map((r) => r.message),
      );
      report.frames.push({
        mode: item.mode,
        frame: index,
        proof,
        resources: records,
        plan: { path: local(join(dir, "replay.fpln")), sha256: sha(plan) },
        reference: {
          path: local(join(dir, "frame.png")),
          sha256: sha(png),
          rgba_sha256: sha(pixels),
        },
      });
    }
  }
  const path = join(config.output, "frame-capture.json");
  await writeAtomicJson(path, report);
  return { path: local(path), frames: report.frames.length };
}
