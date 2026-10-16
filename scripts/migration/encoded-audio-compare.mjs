import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { consumeDecoderOutput } from "./media-decode-stream.mjs";
import { hashFile } from "./source.mjs";

/** Hash the addressed stereo f32 PCM interval while bounding AAC-LC tail padding. */
export async function consumeDecodedPcm(stream, frameCount, progress = () => {}) {
  assert(Number.isSafeInteger(frameCount) && frameCount > 0, "Invalid audio frame count");
  const expectedBytes = frameCount * 8;
  assert(Number.isSafeInteger(expectedBytes) && expectedBytes > 0, "Invalid audio frame count");
  const segment = createHash("sha256"),
    full = createHash("sha256");
  let bytes = 0;
  for await (const chunk of stream) {
    assert(Buffer.isBuffer(chunk), "Audio decoder must emit binary data");
    assert(bytes + chunk.length <= expectedBytes + 1023 * 8, "Excess decoded audio padding");
    if (bytes < expectedBytes) segment.update(chunk.subarray(0, expectedBytes - bytes));
    full.update(chunk);
    bytes += chunk.length;
    if (chunk.length > 0) progress();
  }
  assert.equal(bytes % 8, 0, "Truncated stereo PCM frame");
  assert(bytes >= expectedBytes, "Decoded audio is shorter than the addressed segment");
  return {
    expected_frames: frameCount,
    decoded_frames: bytes / 8,
    padding_frames: bytes / 8 - frameCount,
    segment_sha256: segment.digest("hex"),
    full_sha256: full.digest("hex"),
  };
}

/** Audio uses the unchanged mixer/encoder, so native and independently retained TS PCM must agree. */
export async function compareExportAudio(context, outputs) {
  const report = { status: "failed", passed: false, arms: {} };
  try {
    const counts = [outputs.native.audiovisual.audio_frames, outputs.ts.audiovisual.audio_frames];
    assert(
      counts.every((value) => Number.isSafeInteger(value) && value >= 0),
      "Invalid admitted audio length",
    );
    assert.equal(counts[0], counts[1], "Audio segment lengths differ between renderers");
    for (const arm of ["native", "ts"]) {
      const output = outputs[arm];
      assert.equal(output.audiovisual.status, "passed");
      assert.equal(
        await hashFile(output.path),
        output.sha256,
        "Export changed before audio decode",
      );
      const streams = output.probe.streams.filter((stream) => stream.codec_type === "audio");
      assert.equal(
        streams.length,
        counts[0] ? 1 : 0,
        "Audio stream presence differs from admission",
      );
      if (!counts[0]) {
        assert.equal(output.audiovisual.required_audio, false, "Required audio is absent");
        continue;
      }
      const audio = streams[0];
      assert.equal(audio.codec_name, "aac");
      assert.equal(audio.profile, "LC", "Audio padding bounds require AAC-LC");
      assert.equal(Number(audio.sample_rate), 48000);
      assert.equal(audio.channels, 2);
      assert(typeof audio.start_time === "string" && Number.isFinite(Number(audio.start_time)));
      assert(Math.abs(Number(audio.start_time)) <= 0.001, "Audio start is offset");
      const decoded = await consumeDecoderOutput(
        { ffmpeg: join(context.root, "build/ffmpeg/ffmpeg.exe") },
        [
          "-v",
          "error",
          "-nostdin",
          "-threads",
          "1",
          "-i",
          output.path,
          "-map",
          "0:a:0",
          "-vn",
          "-sn",
          "-dn",
          "-threads",
          "1",
          "-f",
          "f32le",
          "-c:a",
          "pcm_f32le",
          "pipe:1",
        ],
        (stream, progress) => consumeDecodedPcm(stream, counts[0], progress),
      );
      assert.equal(
        await hashFile(output.path),
        output.sha256,
        "Export changed during audio decode",
      );
      report.arms[arm] = { path: output.path, sha256: output.sha256, decoded };
    }
    if (!counts[0]) return { ...report, status: "not-applicable", passed: true };
    report.passed =
      report.arms.native.decoded.segment_sha256 === report.arms.ts.decoded.segment_sha256;
    report.status = report.passed ? "passed" : "failed";
    if (!report.passed) report.error = "Decoded audio content differs within the addressed segment";
    report.scope =
      "Exact native/retained-TS decoded stereo PCM over the addressed interval; AAC-LC tail padding is bounded separately";
  } catch (error) {
    report.error = error.stack ?? String(error);
  }
  return report;
}
