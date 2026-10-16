import assert from "node:assert/strict";
import { relative, resolve } from "node:path";
import { decodeRgbaPng } from "../parity/png.mjs";
import { auditEncodedReferenceDomain } from "./encoded-reference-domain.mjs";
import { auditExportQuality } from "./export-quality.mjs";
import { M0Evidence, validSha } from "./m0-evidence.mjs";
import { auditCorpusAudiovisual } from "./native-corpus-runs.mjs";

/** Recompute acceptance from authenticated execution records instead of trusting summary flags. */
export async function auditExportCaseEvidence(root, report, assignment) {
  const reader = new M0Evidence(root);
  const entry = report.cases[0],
    job = report.assignments[0];
  assert.equal(report.assignments.length, 1);
  for (const key of Object.keys(assignment)) assert.deepEqual(job[key], assignment[key]);
  const start = Math.min(...assignment.case.frames),
    end = Math.max(...assignment.case.frames) + 1;
  assert.equal(job.benchmark.startFrame, start);
  assert.equal(job.benchmark.endFrameExclusive, end);
  assert.deepEqual(entry.frames, assignment.case.frames);
  assert.equal(entry.frame_count, end - start);
  for (const reference of entry.references) {
    const original = decodeRgbaPng(
      (
        await reader.bytes(
          relative(root, resolve(root, reference.original.path)).replaceAll("\\", "/"),
          reference.original.sha256,
        )
      ).bytes,
    );
    const derived = decodeRgbaPng(
      (
        await reader.bytes(
          relative(root, reference.derived.path).replaceAll("\\", "/"),
          reference.derived.sha256,
        )
      ).bytes,
    );
    assert.equal(original.width, assignment.case.size.width);
    assert.equal(original.height, assignment.case.size.height);
    assert.equal(derived.width, original.width);
    assert.equal(derived.height, original.height);
    for (let index = 3; index < original.pixels.length; index += 4) original.pixels[index] = 255;
    assert.deepEqual(derived.pixels, original.pixels, "Opaque reference must preserve frozen RGB");
  }
  for (const [arm, renderer] of [
    ["native", "rust"],
    ["ts", "ts"],
  ]) {
    const execution = report.execution.arms[renderer];
    const raw = await reader.json(execution.path, execution.sha256);
    assert.deepEqual(raw, execution.raw);
    assert.equal(raw.status, "passed");
    assert.equal(raw.cases.length, 1);
    const captured = raw.cases[0],
      output = entry.outputs[arm];
    assert.equal(output.reference_domain.width, assignment.case.size.width);
    assert.equal(output.reference_domain.height, assignment.case.size.height);
    await auditEncodedReferenceDomain(reader, output.reference_domain, entry.references);
    const converted = new Map(
      output.reference_domain.references.map((r) => [resolve(r.decoded.path), r.decoded.sha256]),
    );
    for (const comparison of entry.comparisons.filter((item) => item.name === arm)) {
      const measured = await reader.json(comparison.report, comparison.report_sha256);
      assert.equal(measured.context.g5_uniform_reference, true);
      for (const key of ["reference", "previous", "next"]) {
        if (!measured[key]) continue;
        const path = measured[key].path.replace(/^\\\\\?\\/, "");
        const frame = start + comparison.index + (key === "previous" ? -1 : key === "next" ? 1 : 0);
        const frozen = entry.references.find((item) => item.frame === frame);
        assert(frozen, "Comparison reference has no frozen frame identity");
        const expected = output.reference_domain.references.find(
          (item) => resolve(item.source.path) === resolve(frozen.derived.path),
        );
        assert(expected, "Missing converted reference for addressed frame");
        assert.equal(resolve(path), resolve(expected.decoded.path));
        assert.equal(
          converted.get(resolve(path)),
          measured[key].png_sha256,
          "Comparison left the independent reference domain",
        );
      }
    }
    assert.equal(captured.status, "passed");
    assert.equal(captured.caseId, assignment.case.id);
    assert.equal(captured.case_hash, assignment.caseHash);
    assert.deepEqual(captured.inputs, assignment.inputs);
    assert.deepEqual(captured.benchmark, {
      ...job.benchmark,
      id: `${entry.id}-${renderer}-corpus-export`,
      ...(arm === "native" ? { renderer: "rust" } : {}),
    });
    assert.equal(captured.result.startFrame, start);
    assert.equal(captured.result.endFrameExclusive, end);
    assert.equal(captured.result.frames, end - start);
    if (arm === "native") assert.equal(captured.result.renderer, "rust");
    else assert.deepEqual(raw.retained_runtime, report.execution.retained);
    assert.equal(captured.output.videoBitrateBps, 20000000);
    assert.equal(resolve(root, output.path), resolve(captured.output.outputPath));
    assert.equal(output.sha256, captured.output.ffprobe.sha256);
    await reader.bytes(output.path, output.sha256);
    assert.deepEqual(output.probe, captured.output.ffprobe.result);
    assert.deepEqual(output.audiovisual, auditCorpusAudiovisual(job, captured));
    assert.deepEqual(output.decoded, {
      frame_count: end - start,
      frame_bytes: assignment.case.size.width * assignment.case.size.height * 4,
    });
  }
  await auditExportQuality(reader, entry.quality, entry.frames.length);
  const count = entry.outputs.native.audiovisual.audio_frames;
  assert.equal(entry.outputs.ts.audiovisual.audio_frames, count);
  if (count === 0) {
    assert.equal(entry.audio.status, "not-applicable");
    assert.equal(entry.audio.passed, true);
    assert.deepEqual(entry.audio.arms, {});
    for (const output of Object.values(entry.outputs)) {
      assert.equal(output.audiovisual.required_audio, false);
      assert.equal(output.probe.streams.filter((s) => s.codec_type === "audio").length, 0);
    }
  } else {
    for (const arm of ["native", "ts"]) {
      const audio = entry.audio.arms[arm],
        output = entry.outputs[arm];
      assert.equal(relative(root, audio.path), relative(root, resolve(root, output.path)));
      assert.equal(audio.sha256, output.sha256);
      const streams = output.probe.streams.filter((s) => s.codec_type === "audio");
      assert.equal(streams.length, 1);
      assert.equal(streams[0].codec_name, "aac");
      assert.equal(streams[0].profile, "LC");
      assert.equal(Number(streams[0].sample_rate), 48000);
      assert.equal(streams[0].channels, 2);
      const decoded = audio.decoded;
      assert.equal(decoded.expected_frames, count);
      assert(
        Number.isSafeInteger(decoded.padding_frames) &&
          decoded.padding_frames >= 0 &&
          decoded.padding_frames <= 1023,
      );
      assert.equal(decoded.decoded_frames, count + decoded.padding_frames);
      validSha(decoded.segment_sha256);
      validSha(decoded.full_sha256);
    }
    const matched =
      entry.audio.arms.native.decoded.segment_sha256 === entry.audio.arms.ts.decoded.segment_sha256;
    assert.equal(entry.audio.passed, matched);
    assert.equal(entry.audio.status, matched ? "passed" : "failed");
  }
  await reader.stable();
}
