import assert from "node:assert/strict";
import { consumeDecoderOutput } from "./media-decode-stream.mjs";

/** Assemble one owned frame at a time and await its consumer before reading more output. */
export async function consumeRgbaFrames(stream, { width, height, frameCount }, consume) {
  for (const value of [width, height, frameCount])
    assert(Number.isSafeInteger(value) && value > 0, "Invalid decoded frame layout");
  const length = width * height * 4;
  assert(Number.isSafeInteger(length) && length <= 256 * 1024 * 1024, "Decoded frame too large");
  let pixels = null,
    offset = 0,
    index = 0;
  for await (const chunk of stream) {
    assert(Buffer.isBuffer(chunk), "Decoder must emit binary chunks");
    let position = 0;
    while (position < chunk.length) {
      assert(index < frameCount, "Decoder emitted extra frames or trailing bytes");
      pixels ??= Buffer.allocUnsafe(length);
      const count = Math.min(length - offset, chunk.length - position);
      chunk.copy(pixels, offset, position, position + count);
      position += count;
      offset += count;
      if (offset === length) {
        await consume(pixels, index);
        index++;
        offset = 0;
        pixels = null;
      }
    }
  }
  assert.equal(offset, 0, "Decoder ended inside a frame");
  assert.equal(index, frameCount, "Decoder emitted too few frames");
  return { frame_count: index, frame_bytes: length };
}

/** Drain a complete video, rejecting incomplete output even when FFmpeg exits successfully. */
export async function decodeExportFrames(options, consume, launch) {
  return consumeDecoderOutput(
    options,
    [
      "-v",
      "error",
      "-nostdin",
      "-threads",
      "1",
      "-i",
      options.path,
      "-map",
      "0:v:0",
      "-an",
      "-sn",
      "-dn",
      "-vf",
      "scale=flags=bicubic+accurate_rnd+full_chroma_int,format=rgba",
      "-fps_mode",
      "passthrough",
      "-threads",
      "1",
      "-f",
      "rawvideo",
      "-pix_fmt",
      "rgba",
      "pipe:1",
    ],
    (stream, progress) =>
      consumeRgbaFrames(stream, options, async (pixels, index) => {
        await consume(pixels, index);
        progress();
      }),
    launch,
  );
}
