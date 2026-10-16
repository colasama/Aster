import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import { promisify } from "node:util";
import { consumeRgbaFrames, decodeExportFrames } from "./encoded-frame-reader.mjs";

test("limited-range neutral samples decode with accurate RGB rounding", {
  skip: process.platform !== "win32",
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), "aster-decode-rounding-"));
  const ffmpeg = join(process.cwd(), "build/ffmpeg/ffmpeg.exe");
  try {
    const width = 96,
      height = 32,
      bytes = Buffer.alloc((width * height * 3) / 2, 128);
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) bytes[y * width + x] = [16, 126, 235][Math.floor(x / 32)];
    const source = join(directory, "neutral.yuv"),
      path = join(directory, "neutral.mkv");
    await writeFile(source, bytes);
    await promisify(execFile)(
      ffmpeg,
      [
        "-v",
        "error",
        "-f",
        "rawvideo",
        "-pixel_format",
        "yuv420p",
        "-video_size",
        "96x32",
        "-i",
        source,
        "-frames:v",
        "1",
        "-c:v",
        "ffv1",
        "-colorspace",
        "bt709",
        "-color_range",
        "tv",
        "-threads",
        "1",
        path,
      ],
      { windowsHide: true, timeout: 30000 },
    );
    await decodeExportFrames({ ffmpeg, path, width, height, frameCount: 1 }, async (rgba) => {
      for (let y = 0; y < height; y++)
        for (let x = 0; x < width; x++) {
          const expected = Math.round((([16, 126, 235][Math.floor(x / 32)] - 16) * 255) / 219);
          const offset = (y * width + x) * 4;
          for (let c = 0; c < 3; c++) assert(Math.abs(rgba[offset + c] - expected) <= 1);
          assert.equal(rgba[offset + 3], 255);
        }
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("verified frame progress permits long consumers while a stalled consumer is terminated", async () => {
  const options = {
    ffmpeg: "ffmpeg",
    path: "clip",
    width: 2,
    height: 2,
    frameCount: 3,
    timeoutMs: 500,
  };
  let child;
  const launch = (_file, _args, settings) => {
    child = spawn(
      process.execPath,
      ["-e", "process.stdout.write(Buffer.alloc(48)); setInterval(()=>{},1000);"],
      settings,
    );
    return child;
  };
  let count = 0;
  // The child deliberately stays alive: EOF/drain must still be bounded after every frame succeeds.
  await assert.rejects(
    decodeExportFrames(
      options,
      async () => {
        await new Promise((resolve) => setTimeout(resolve, 300));
        count++;
      },
      launch,
    ),
    /timed out/,
  );
  assert.equal(count, 3);
  assert(child.exitCode !== null || child.signalCode !== null);
  await assert.rejects(
    decodeExportFrames(
      { ...options, frameCount: 1, timeoutMs: 200 },
      () => new Promise(() => {}),
      launch,
    ),
    /timed out/,
  );
  assert(child.exitCode !== null || child.signalCode !== null);
  const result = await decodeExportFrames(
    options,
    async () => {
      await new Promise((resolve) => setTimeout(resolve, 300));
    },
    (_file, _args, settings) =>
      spawn(process.execPath, ["-e", "process.stdout.write(Buffer.alloc(48));"], settings),
  );
  assert.equal(result.frame_count, 3);
});

test("split and combined pipe chunks preserve owned frames and serial backpressure", async () => {
  const bytes = Buffer.from(Array.from({ length: 48 }, (_, i) => i));
  const frames = [];
  let busy = false;
  const result = await consumeRgbaFrames(
    Readable.from([bytes.subarray(0, 3), bytes.subarray(3, 37), bytes.subarray(37)]),
    { width: 2, height: 2, frameCount: 3 },
    async (pixels, index) => {
      assert.equal(busy, false);
      busy = true;
      await new Promise((done) => setImmediate(done));
      frames.push(pixels);
      assert.deepEqual(pixels, bytes.subarray(index * 16, (index + 1) * 16));
      busy = false;
    },
  );
  assert.deepEqual(result, { frame_count: 3, frame_bytes: 16 });
  bytes.fill(255);
  assert.equal(frames[0][0], 0);
  assert.equal(frames[1][0], 16);
  assert.equal(frames[2][0], 32);
});

test("truncated, missing and extra decoded output cannot be accepted", async () => {
  for (const [length, error] of [
    [15, /inside a frame/],
    [16, /too few/],
    [33, /extra/],
  ]) {
    await assert.rejects(
      consumeRgbaFrames(
        Readable.from([Buffer.alloc(length)]),
        { width: 2, height: 2, frameCount: 2 },
        async () => {},
      ),
      error,
    );
  }
  for (const width of [0, -1, 1.5, Number.MAX_SAFE_INTEGER]) {
    await assert.rejects(
      consumeRgbaFrames(Readable.from([]), { width, height: 2, frameCount: 1 }, async () => {}),
    );
  }
});

test("long streams are consumed incrementally without retaining prior frames", async () => {
  let produced = 0,
    consumed = 0;
  async function* frames() {
    for (let i = 0; i < 1000; i++) {
      // Readable may prefetch one chunk, but cannot drain the whole input while a consumer waits.
      assert(produced - consumed <= 1);
      produced++;
      yield Buffer.alloc(16, i % 256);
    }
  }
  await consumeRgbaFrames(
    Readable.from(frames(), { highWaterMark: 1 }),
    { width: 2, height: 2, frameCount: 1000 },
    async (pixels, index) => {
      await new Promise((done) => setImmediate(done));
      assert.equal(pixels[0], index % 256);
      consumed++;
    },
  );
  assert.equal(consumed, 1000);
});

test("decode waits for process success and terminates a process on consumer failure", async () => {
  const options = { ffmpeg: "ffmpeg", path: "clip.mp4", width: 2, height: 2, frameCount: 1 };
  const launcher =
    (source, observe = () => {}) =>
    (_file, args, settings) => {
      assert(!args.includes("-frames:v"), "Extra decoder output must remain detectable");
      const child = spawn(process.execPath, ["-e", source], settings);
      observe(child);
      return child;
    };
  await assert.rejects(
    decodeExportFrames(
      options,
      async () => {},
      launcher("process.stdout.write(Buffer.alloc(16)); process.exitCode=2;"),
    ),
    /decode failed/,
  );
  let child;
  await assert.rejects(
    decodeExportFrames(
      options,
      async () => {
        throw new Error("consumer failed");
      },
      launcher("process.stdout.write(Buffer.alloc(16)); setInterval(()=>{},1000);", (value) => {
        child = value;
      }),
    ),
    /consumer failed/,
  );
  assert(child.exitCode !== null || child.signalCode !== null);
  await assert.rejects(
    decodeExportFrames(
      { ...options, timeoutMs: 100 },
      async () => {},
      launcher("setInterval(()=>{},1000);"),
    ),
    /timed out/,
  );
});
