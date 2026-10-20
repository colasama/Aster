import assert from "node:assert/strict";
import { dirname, isAbsolute, resolve } from "node:path";
import { containedPath } from "../parity/pixel-inputs.mjs";

/** Reuse the authenticated catalog without resetting its repair audit for every native witness. */
export async function projectPixelEntries(root, manifestPath, inputs) {
  assert.equal(resolve(inputs.context.root), resolve(root));
  assert(inputs.ledger && inputs.corpus && inputs.catalog);
  const path = resolve(root, manifestPath);
  const manifest = await inputs.json(path);
  assert.equal(manifest.schema_version, 1);
  assert.equal(manifest.kind, "native-project-export-witness");
  assert(Array.isArray(manifest.frames) && manifest.frames.length > 0);
  const seen = new Set();
  return manifest.frames.map((entry) => {
    const item = inputs.corpus.cases.find((item) => item.id === entry.case_id);
    assert(item?.frames.includes(entry.frame), "Unknown witness frame");
    const key = `${entry.case_id}/${entry.frame}`;
    assert(!seen.has(key), "Duplicate witness frame");
    seen.add(key);
    assert(/^[a-f0-9]{64}$/.test(entry.png_sha256), "Missing witness PNG hash");
    assert(typeof entry.path === "string" && !isAbsolute(entry.path));
    return {
      ...entry,
      path: containedPath(dirname(path), entry.path),
      item,
      profile: item.tolerance,
    };
  });
}
