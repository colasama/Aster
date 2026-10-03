import assert from "node:assert/strict";
import { posix } from "node:path";
import { evidencePath, validSha } from "./m0-evidence.mjs";

function indexed(records, required, label) {
  assert(Array.isArray(records));
  assert.equal(records.length, required.size, `${label} coverage is incomplete`);
  const entries = new Map();
  for (const record of records) {
    const key = `${record.case_id}:${record.frame}`;
    assert(required.has(key) && !entries.has(key), `${label} has duplicate or unexpected frames`);
    entries.set(key, record);
  }
  return entries;
}

async function png(reader, path, hash, width, height) {
  const { bytes } = await reader.bytes(path, validSha(hash));
  assert(
    bytes.length >= 24 &&
      bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])),
    "Pixel evidence is not PNG",
  );
  assert.equal(bytes.readUInt32BE(16), width);
  assert.equal(bytes.readUInt32BE(20), height);
}

/** Keep the files compared by this run intact until the milestone exit audit finishes. */
export async function auditM1Pixels(reader, exact, corpus, binding) {
  const required = new Map();
  for (const item of corpus.cases) {
    assert(/^[a-z0-9-]+$/.test(item.id), "Unsafe corpus case ID");
    for (const frame of item.frames) {
      assert(Number.isSafeInteger(frame) && frame >= 0);
      const key = `${item.id}:${frame}`;
      assert(!required.has(key), "Duplicate required TS frame");
      required.set(key, item);
    }
  }
  assert(required.size > 0);
  const gate = exact.gate;
  assert.equal(gate.id, "G3");
  assert.equal(gate.required_count, required.size);
  const frames = indexed(gate.frames, required, "G3 frames");
  const comparisons = indexed(gate.comparisons, required, "G3 comparisons");
  assert.deepEqual(
    gate.evidence,
    gate.comparisons.map((record) => record.evidence),
  );
  const manifest = await reader.json(
    exact.candidate_manifest.path,
    validSha(exact.candidate_manifest.sha256),
  );
  assert.equal(manifest.schema_version, 1);
  const candidates = indexed(manifest.frames, required, "Candidate PNGs");
  const directory = posix.dirname(evidencePath(exact.candidate_manifest.path));
  const catalog = await reader.bytes("tests/parity/tolerances.json");
  const repairs = new Map(
    binding.repairs.map((repair) => [`${repair.case_id}:${repair.frame}`, repair.path]),
  );
  const referencePath = (id, frame) =>
    repairs.get(`${id}:${frame}`) ?? `artifacts/parity/reference/${id}/${frame}/frame.png`;
  for (const [key, item] of required) {
    const frame = frames.get(key);
    const record = comparisons.get(key);
    const candidate = candidates.get(key);
    assert.equal(frame.status, "passed");
    assert.equal(frame.profile, "exact", "M1 does not permit a non-exact tolerance");
    assert.equal(frame.self_review_required, false);
    assert.equal(frame.step?.status, "passed");
    assert.equal(frame.step.exit_code, 0);
    assert(!frame.step.error && !frame.step.signal, "Pixel comparison was interrupted");
    assert.deepEqual(frame.evidence, record.evidence);
    const evidence = record.evidence;
    const report = await reader.json(evidence.report, validSha(evidence.report_sha256));
    assert.equal(report.schema_version, 1);
    assert.deepEqual(report.comparison, record.comparison);
    const comparison = report.comparison;
    assert.equal(comparison.schema_version, 1);
    assert.equal(comparison.profile.name, "exact");
    assert.equal(comparison.profile.catalog_sha256, catalog.sha256);
    assert.equal(comparison.passed, true);
    assert.equal(comparison.self_review_required, false);
    assert.equal(comparison.metrics.exact, true);
    assert.equal(comparison.reference_rgba_sha256, validSha(comparison.candidate_rgba_sha256));
    assert.equal(comparison.candidate_rgba_sha256, validSha(candidate.rgba_sha256));
    assert.equal(comparison.width, item.size.width);
    assert.equal(comparison.height, item.size.height);
    assert.equal(comparison.metrics.pixel_count, item.size.width * item.size.height);
    for (const metric of [
      "max_abs_channel_error",
      "mean_abs_error",
      "mean_squared_error",
      "rgb_mean_squared_error",
      "pixels_above_tolerance",
    ])
      assert.equal(comparison.metrics[metric], 0);
    assert.deepEqual(
      comparison.checks.map((check) => check.id).sort(),
      item.sequence ? ["exact_rgba", "frame_identity"] : ["exact_rgba"],
    );
    assert(comparison.checks.every((check) => check.passed === true));
    assert.equal(report.context.case_id, item.id);
    assert.equal(report.context.isolated, Boolean(item.isolated));
    assert.equal(comparison.isolated, Boolean(item.isolated));
    assert.equal(Boolean(report.context.sequence), Boolean(item.sequence));
    assert.equal(report.candidate.png_sha256, validSha(candidate.png_sha256));
    await png(
      reader,
      posix.join(directory, evidencePath(candidate.path)),
      candidate.png_sha256,
      item.size.width,
      item.size.height,
    );
    await png(
      reader,
      referencePath(item.id, frame.frame),
      report.reference.png_sha256,
      item.size.width,
      item.size.height,
    );
    if (item.sequence) {
      const sequence = report.context.sequence;
      assert.equal(sequence.frame, frame.frame);
      assert.equal(sequence.first_frame, 0);
      assert(Number.isSafeInteger(sequence.last_frame) && sequence.last_frame >= frame.frame);
      assert.equal(comparison.sequence?.passed, true);
      for (const [side, neighbor] of [
        ["previous", frame.frame - 1],
        ["next", frame.frame + 1],
      ]) {
        const expected = neighbor >= sequence.first_frame && neighbor <= sequence.last_frame;
        assert.equal(Boolean(report[side]), expected, "Sequence neighbor evidence is incomplete");
        if (expected)
          await png(
            reader,
            referencePath(item.id, neighbor),
            report[side].png_sha256,
            item.size.width,
            item.size.height,
          );
      }
    } else {
      assert.equal(comparison.sequence, null);
      assert.equal(report.previous, null);
      assert.equal(report.next, null);
    }
    for (const [name, filename, scale] of [
      ["heatmap", "heatmap.png", 1],
      ["contact_sheet", "contact-sheet.png", 2],
    ]) {
      assert.equal(evidence[name], posix.join(posix.dirname(evidence.report), filename));
      await png(
        reader,
        evidence[name],
        evidence[`${name}_sha256`],
        item.size.width * scale,
        item.size.height * scale,
      );
    }
  }
  return { status: "passed", frames: required.size, comparisons: comparisons.size };
}
