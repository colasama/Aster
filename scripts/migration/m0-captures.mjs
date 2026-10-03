import assert from "node:assert/strict";
import { captureFrames, digest } from "../parity/provenance.mjs";
import { evidencePath, stableSource, validSha } from "./m0-evidence.mjs";

export function capturedCaseSet(report, corpus) {
  assert.equal(report.status, "passed");
  assert.equal(report.exit_code, 0);
  assert.equal(report.source_unchanged, true);
  stableSource(report.source, report.source_after, "renderer_source_sha256");
  assert.deepEqual(
    report.cases.map((item) => item.id).sort(),
    corpus.cases.map((item) => item.id).sort(),
  );
  assert(
    report.cases.every((item) => ["passed", "cached"].includes(item.status)),
    "Capture case did not complete",
  );
}

/** Every requested and adjacent frame is decoded; metadata cannot assert a false raw pixel hash. */
export async function auditCaptureSet(
  reader,
  corpus,
  directory,
  sourceHash,
  caseRecords,
  provenance,
) {
  const frames = new Map();
  const captures = new Map();
  const records = caseRecords ? new Map(caseRecords.map((item) => [item.case_id, item])) : null;
  if (records)
    assert.equal(
      records.size,
      corpus.cases.length,
      "Candidate case records are duplicated or incomplete",
    );
  for (const item of corpus.cases) {
    assert(/^[a-z0-9-]+$/.test(item.id), "Unsafe corpus case ID");
    const record = records?.get(item.id);
    if (records) assert(record, "Candidate case is missing");
    const capturePath = `${directory}/${item.id}/capture.json`;
    if (record) assert.equal(record.path, `${item.id}/capture.json`);
    const capture = await reader.json(capturePath, record?.capture_sha256);
    assert.equal(capture.schema_version, 1);
    assert.equal(capture.source_verified, true);
    assert.equal(capture.case_id, item.id);
    assert.deepEqual(capture.inputs.case, item, "Captured case differs from corpus");
    const caseHash = digest(capture.inputs);
    const listed = capture.frames.map((frame) => frame.frame);
    assert.equal(new Set(listed).size, listed.length, "Capture repeats a frame");
    assert(listed.every((frame) => Number.isSafeInteger(frame) && frame >= 0));
    assert.deepEqual(listed, capture.inputs.frames, "Captured frame list differs from its inputs");
    assert(
      item.frames.every((frame) => listed.includes(frame)),
      "Required frame is absent",
    );
    let expectedFrames = item.frames;
    let sequenceDomain = null;
    if (item.sequence) {
      const project = await reader.json(item.project, validSha(capture.inputs.project_sha256));
      const composition = project.compositions.find((value) => value.id === item.composition);
      assert(composition, "Sequence composition is absent");
      expectedFrames = captureFrames(item, composition);
      sequenceDomain = {
        first_frame: 0,
        last_frame:
          Math.ceil(
            (composition.duration * composition.frameRate.numerator) /
              composition.frameRate.denominator,
          ) - 1,
      };
    }
    assert.deepEqual(listed, expectedFrames, "Required adjacent capture frames are absent");
    if (record) {
      assert.equal(record.case_sha256, caseHash);
      assert.deepEqual(record.requested_frames, item.frames);
      assert.deepEqual(record.captured_frames, listed);
    }
    for (const entry of capture.frames) {
      const prefix = `${directory}/${item.id}/${entry.frame}`;
      const meta = await reader.json(`${prefix}/meta.json`, validSha(entry.meta_sha256));
      const image = await reader.image(`${prefix}/frame.png`, validSha(entry.png_sha256));
      assert.equal(meta.case_id, item.id);
      assert.equal(meta.frame, entry.frame);
      assert.equal(meta.requested, item.frames.includes(entry.frame));
      assert.equal(
        meta.renderer_source_sha256,
        sourceHash,
        "Capture uses an unapproved renderer source",
      );
      if (provenance) {
        if (provenance.caseStatus?.get(item.id) === "cached") {
          assert(typeof meta.run_id === "string" && meta.run_id.length > 0);
          validSha(meta.source_tree_sha256);
        } else {
          assert.equal(meta.run_id, provenance.run_id);
          assert.equal(meta.source_tree_sha256, provenance.source.tree_sha256);
        }
        assert.deepEqual(meta.host.cacheIdentity, provenance.host.cacheIdentity);
      }
      assert.equal(meta.case_sha256, caseHash);
      assert.equal(meta.cache_key, capture.cache_key);
      assert.equal(
        meta.cache_key,
        digest({
          source: sourceHash,
          case: caseHash,
          adapter: meta.host.cacheIdentity ?? meta.host,
        }),
      );
      assert.equal(meta.pixel_format, "rgba8");
      assert.equal(meta.png_sha256, image.png_sha256);
      assert.equal(meta.rgba_sha256, image.rgba_sha256, "Captured RGBA bytes differ from metadata");
      assert.deepEqual(meta.size, item.size);
      assert.equal(image.width, item.size.width);
      assert.equal(image.height, item.size.height);
      assert.equal(meta.aa, item.aa);
      assert(
        Number.isSafeInteger(meta.frame_rate?.numerator) &&
          meta.frame_rate.numerator > 0 &&
          Number.isSafeInteger(meta.frame_rate?.denominator) &&
          meta.frame_rate.denominator > 0,
      );
      assert(
        Math.abs(
          meta.time - (entry.frame * meta.frame_rate.denominator) / meta.frame_rate.numerator,
        ) < 1e-8,
      );
      frames.set(`${item.id}/${entry.frame}`, {
        path: `${prefix}/frame.png`,
        metaPath: `${prefix}/meta.json`,
        png_sha256: image.png_sha256,
        rgba_sha256: image.rgba_sha256,
        meta_sha256: entry.meta_sha256,
        width: image.width,
        height: image.height,
        case_sha256: caseHash,
        source_tree_sha256: meta.source_tree_sha256,
        run_id: meta.run_id,
        host: meta.host.cacheIdentity,
        frame_rate: meta.frame_rate,
        sequence: Boolean(item.sequence),
        sequenceDomain,
        isolated: Boolean(item.isolated),
      });
    }
    captures.set(item.id, { caseHash, frames: listed });
  }
  return {
    frames,
    captures,
    digest: digest(
      [...frames].map(([key, value]) => ({ key, png: value.png_sha256, meta: value.meta_sha256 })),
    ),
  };
}

export async function auditCandidate(
  reader,
  corpus,
  manifestPath,
  captureReportPath,
  expectedSource,
) {
  const manifestFile = await reader.bytes(manifestPath);
  const manifest = JSON.parse(manifestFile.bytes.toString("utf8"));
  const report = await reader.json(captureReportPath);
  capturedCaseSet(report, corpus);
  assert(
    report.cases.every((item) => item.status === "passed"),
    "Candidates must be freshly captured",
  );
  assert.equal(report.capture_mode, "candidate");
  assert.equal(report.candidate.manifest, manifestPath);
  assert.equal(report.candidate.manifest_sha256, manifestFile.sha256);
  assert.equal(manifest.schema_version, 1);
  assert.equal(manifest.kind, "ts-candidate");
  assert.equal(manifest.source_verified, true);
  assert.equal(manifest.scope, "full");
  assert.equal(report.candidate.scope, "full");
  assert.equal(
    manifest.source.renderer_source_sha256,
    expectedSource,
    "Candidate is not the current renderer source",
  );
  stableSource(manifest.source, manifest.source_after, "renderer_source_sha256");
  assert.deepEqual(manifest.source, report.source);
  assert.deepEqual(manifest.source_after, report.source_after);
  assert.deepEqual(manifest.host, report.host);
  assert.equal(manifest.run_id, report.run_id);
  assert.equal(manifest.corpus_sha256, (await reader.bytes("tests/parity/corpus.json")).sha256);
  assert.deepEqual([...manifest.selected_cases].sort(), corpus.cases.map((item) => item.id).sort());
  const required = corpus.cases.reduce((count, item) => count + item.frames.length, 0);
  assert.equal(manifest.required_case_count, corpus.cases.length);
  assert.equal(manifest.required_frame_count, required);
  assert.equal(report.candidate.case_count, corpus.cases.length);
  assert.equal(report.candidate.requested_frame_count, required);
  const directory = manifestPath.slice(0, manifestPath.lastIndexOf("/"));
  const captured = await auditCaptureSet(
    reader,
    corpus,
    directory,
    expectedSource,
    manifest.cases,
    { run_id: manifest.run_id, source: manifest.source, host: manifest.host },
  );
  assert.equal(manifest.captured_frame_count, captured.frames.size);
  assert.equal(report.candidate.captured_frame_count, captured.frames.size);
  assert.equal(manifest.frames.length, required);
  const requested = new Map();
  for (const entry of manifest.frames) {
    const key = `${entry.case_id}/${entry.frame}`;
    const item = corpus.cases.find((item) => item.id === entry.case_id);
    assert(
      item?.frames.includes(entry.frame) && !requested.has(key),
      "Unknown or duplicate candidate frame",
    );
    const actual = captured.frames.get(key);
    assert.equal(`${directory}/${evidencePath(entry.path)}`, actual.path);
    assert.equal(`${directory}/${evidencePath(entry.meta_path)}`, actual.metaPath);
    for (const field of ["png_sha256", "meta_sha256", "rgba_sha256"])
      assert.equal(entry[field], actual[field]);
    assert.equal(actual.run_id, manifest.run_id);
    assert.equal(actual.source_tree_sha256, manifest.source.tree_sha256);
    assert.deepEqual(actual.host, manifest.host.cacheIdentity);
    requested.set(key, actual);
  }
  return { ...captured, requested, manifest, manifestHash: manifestFile.sha256, report };
}
