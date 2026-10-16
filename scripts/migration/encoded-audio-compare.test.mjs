import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import { promisify } from "node:util";
import { compareExportAudio, consumeDecodedPcm } from "./encoded-audio-compare.mjs";
import { hashFile } from "./source.mjs";

test("PCM interval hashes are independent of pipe boundaries and exclude bounded AAC padding", async () => {
  const data = Buffer.from(Array.from({ length: 80 }, (_, i) => i));
  const result = await consumeDecodedPcm(
    Readable.from([data.subarray(0, 3), data.subarray(3, 67), data.subarray(67)]),
    8,
  );
  assert.equal(
    result.segment_sha256,
    createHash("sha256").update(data.subarray(0, 64)).digest("hex"),
  );
  assert.equal(result.full_sha256, createHash("sha256").update(data).digest("hex"));
  assert.equal(result.padding_frames, 2);
  for (const [bytes, frames] of [
    [63, 8],
    [56, 8],
    [(8 + 1024) * 8, 8],
    [8, 0.125],
    [8, 0],
  ])
    await assert.rejects(consumeDecodedPcm(Readable.from([Buffer.alloc(bytes)]), frames));
  let yielded = 0;
  async function* chunks() {
    for (let i = 0; i < 1000; i++) {
      yielded++;
      yield Buffer.alloc(8192, i % 256);
    }
  }
  const long = await consumeDecodedPcm(Readable.from(chunks(), { highWaterMark: 1 }), 1024000);
  assert.equal(yielded, 1000);
  assert.equal(long.decoded_frames, 1024000);
});

test("actual AAC decoding rejects shifted, truncated, missing and changed audio", {
  skip: process.platform !== "win32",
}, async () => {
  const root = process.cwd(),
    directory = await mkdtemp(join(tmpdir(), "aster-audio-compare-"));
  const run = promisify(execFile);
  try {
    const source = Buffer.alloc(4800 * 8);
    for (let i = 0; i < 4800; i++) {
      source.writeFloatLE(Math.sin((i * Math.PI * 880) / 48000) * 0.4, i * 8);
      source.writeFloatLE(Math.cos((i * Math.PI * 660) / 48000) * 0.3, i * 8 + 4);
    }
    const shifted = Buffer.concat([Buffer.alloc(32 * 8), source.subarray(0, -32 * 8)]);
    const outputs = {};
    for (const [name, bytes] of [
      ["correct", source],
      ["shifted", shifted],
      ["short", source.subarray(0, 2400 * 8)],
    ]) {
      const input = join(directory, `${name}.f32`),
        path = join(directory, `${name}.m4a`);
      await writeFile(input, bytes);
      await run(
        join(root, "build/ffmpeg/ffmpeg.exe"),
        [
          "-v",
          "error",
          "-f",
          "f32le",
          "-ar",
          "48000",
          "-ac",
          "2",
          "-i",
          input,
          "-c:a",
          "aac",
          "-b:a",
          "192k",
          "-threads",
          "1",
          path,
        ],
        { windowsHide: true, timeout: 30000 },
      );
      const { stdout } = await run(
        join(root, "build/ffmpeg/ffprobe.exe"),
        ["-v", "error", "-show_streams", "-of", "json", path],
        { windowsHide: true, timeout: 30000 },
      );
      outputs[name] = {
        path,
        sha256: await hashFile(path),
        probe: JSON.parse(stdout),
        audiovisual: { status: "passed", audio_frames: 4800, required_audio: true },
      };
    }
    const matched = await compareExportAudio(
      { root },
      { native: outputs.correct, ts: outputs.correct },
    );
    assert.equal(matched.status, "passed", matched.error);
    assert.equal(matched.arms.native.decoded.expected_frames, 4800);
    assert(matched.arms.native.decoded.padding_frames <= 1023);
    for (const [candidate, error] of [
      [outputs.shifted, /content differs/],
      [outputs.short, /shorter/],
      [{ ...outputs.correct, sha256: "0".repeat(64) }, /changed before/],
      [{ ...outputs.correct, probe: { streams: [] } }, /presence/],
      [
        {
          ...outputs.correct,
          probe: {
            streams: outputs.correct.probe.streams.map((s) => ({ ...s, start_time: "0.05" })),
          },
        },
        /offset/,
      ],
    ]) {
      const result = await compareExportAudio({ root }, { native: candidate, ts: outputs.correct });
      assert.equal(result.passed, false);
      assert.match(result.error, error);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
