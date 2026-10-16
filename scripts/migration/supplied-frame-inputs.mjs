import assert from "node:assert/strict";
import { PixelInputs } from "../parity/pixel-inputs.mjs";

const catalogs = new WeakMap();

/** Reference corrections must replay their matching ready-material plan, not the old fallback. */
export async function suppliedFrameRecord(reader, item, frame, base, manifest) {
  if (!catalogs.has(reader))
    catalogs.set(
      reader,
      (async () => {
        const ledger = await reader.json("docs/migration/rust-renderer-progress.json");
        return { ledger, inputs: null };
      })(),
    );
  const catalog = await catalogs.get(reader);
  const repair = catalog.ledger.reference_repairs?.find(
    (r) =>
      r.kind === "material-ready-first-frame-reference-repair-v1" &&
      r.case_id === item.id &&
      r.frame === frame,
  );
  if (repair) {
    catalog.inputs ??= new PixelInputs({ root: reader.root, env: process.env });
    if (!catalog.inputs.corpus) await catalog.inputs.loadReferenceCatalog();
    const reference = await catalog.inputs.reference(item, frame);
    assert.equal(reference.meta.renderer_source_sha256, repair.renderer_source_sha256);
    base = repair.directory;
    manifest = await reader.json(repair.candidate_manifest, repair.candidate_manifest_sha256);
    await catalog.inputs.verifyStable();
  }
  const source = manifest.cases.find((c) => c.case_id === item.id);
  assert(source, "Missing supplied frame case");
  const capture = await reader.json(`${base}/${source.path}`, source.capture_sha256);
  assert.deepEqual(capture.inputs.case, item);
  const record = capture.frames.find((f) => f.frame === frame);
  assert(record, "Missing supplied frame");
  const meta = await reader.json(`${base}/${item.id}/${frame}/meta.json`, record.meta_sha256);
  return { base, manifest, capture, record, meta };
}
