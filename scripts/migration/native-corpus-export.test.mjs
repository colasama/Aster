import assert from "node:assert/strict";
import test from "node:test";
import { corpusExportAssignment } from "./native-corpus-export.mjs";
import { auditCorpusAudiovisual } from "./native-corpus-runs.mjs";

test("corpus exports preserve sparse frame identities while covering the entire segment", () => {
  const input = {
    case: { id: "sample", composition: "comp", frames: [30, 60, 119] },
    inputs: { frozen: true },
  };
  const composition = { id: "comp", duration: 4, frameRate: { numerator: 30, denominator: 1 } };
  const result = corpusExportAssignment(input, composition);
  assert.deepEqual(result.case.frames, [30, 60, 119]);
  assert.equal(result.benchmark.startFrame, 30);
  assert.equal(result.benchmark.endFrameExclusive, 120);
  assert.strictEqual(result.inputs, input.inputs);
  assert.throws(() =>
    corpusExportAssignment({ ...input, unavailable: "missing project" }, composition),
  );
  assert.throws(() => corpusExportAssignment(input, { ...composition, id: "wrong" }));
  assert.throws(() => corpusExportAssignment(input, { ...composition, duration: 3 }));
});

test("owner and declared audio cases require an actual complete zero-based audio stream", () => {
  const composition = { id: "comp", duration: 3, frameRate: { numerator: 30, denominator: 1 } };
  const input = {
    case: {
      id: "audio",
      composition: "comp",
      frames: [30, 59],
      size: { width: 320, height: 180 },
      features: ["layer:audio"],
    },
  };
  const job = corpusExportAssignment(input, composition);
  assert.equal(job.benchmark.requireAudio, true);
  const owner = corpusExportAssignment(
    { case: { ...input.case, features: [], project: "env:ASTER_PERF_PROJECT" } },
    composition,
  );
  assert.equal(owner.benchmark.requireAudio, true);
  const entry = {
    result: { audio: { enabled: true, sampleRate: 48000, channels: 2, frameCount: 48000 } },
    output: {
      audioFrames: 48000,
      ffprobe: {
        result: {
          streams: [
            {
              codec_type: "video",
              codec_name: "h264",
              width: 320,
              height: 180,
              nb_read_frames: "30",
              avg_frame_rate: "30/1",
              duration: "1",
              start_time: "0",
            },
            {
              codec_type: "audio",
              codec_name: "aac",
              sample_rate: "48000",
              channels: 2,
              duration: "1",
              start_time: "0",
            },
          ],
          format: { duration: "1" },
        },
      },
    },
  };
  assert.equal(auditCorpusAudiovisual(job, entry).segment_start_frame, 30);
  for (const mutate of [
    (e) => {
      e.result.audio = null;
    },
    (e) => {
      e.result.audio.frameCount--;
    },
    (e) => {
      e.output.audioFrames--;
    },
    (e) => {
      e.output.ffprobe.result.streams.pop();
    },
    (e) => {
      e.output.ffprobe.result.streams[1].start_time = "0.05";
    },
    (e) => {
      delete e.output.ffprobe.result.streams[0].start_time;
    },
    (e) => {
      e.output.ffprobe.result.streams[1].duration = "0.5";
    },
  ]) {
    const invalid = structuredClone(entry);
    mutate(invalid);
    assert.throws(() => auditCorpusAudiovisual(job, invalid));
  }
});
