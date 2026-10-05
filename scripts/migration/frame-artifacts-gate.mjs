import assert from "node:assert/strict";
import { posix } from "node:path";
import { validateFrameArtifacts } from "../parity/frame-artifacts.mjs";

/** Audit every captured address, including sequence neighbors absent from the pixel manifest. */
export async function auditFrameArtifacts(reader, manifestPath) {
  const manifest = await reader.json(manifestPath);
  const corpus = await reader.json("tests/parity/corpus.json", manifest.corpus_sha256);
  const base = posix.dirname(manifestPath);
  let frames = 0,
    resources = 0,
    resourceBytes = 0,
    nestedPlans = 0;
  for (const item of manifest.cases) {
    const capture = await reader.json(`${base}/${item.path}`, item.capture_sha256);
    const definition = corpus.cases.find((entry) => entry.id === item.case_id);
    assert(definition, "Unknown captured frame case");
    assert.deepEqual(
      capture.frames.map((frame) => frame.frame),
      item.captured_frames,
    );
    const cache = new Map();
    for (const record of capture.frames) {
      const meta = await reader.json(
        `${base}/${item.case_id}/${record.frame}/meta.json`,
        record.meta_sha256,
      );
      assert.equal(meta.case_sha256, item.case_sha256);
      assert.equal(meta.frame, record.frame);
      const report = await validateFrameArtifacts(
        async (path) => (await reader.bytes(`${base}/${item.case_id}/${path}`)).bytes,
        meta,
        definition,
        manifest.source,
        cache,
      );
      nestedPlans += report.nested_plans;
      frames++;
    }
    resources += cache.size;
    resourceBytes += [...cache.values()].reduce((sum, entry) => sum + entry.length, 0);
  }
  assert.equal(frames, manifest.captured_frame_count);
  return {
    status: "passed",
    frames,
    cases: manifest.cases.length,
    resources,
    resource_bytes: resourceBytes,
    nested_plans: nestedPlans,
    exact_rust_roundtrip: true,
    exact_ts_replay: true,
  };
}
