import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { projectPixelEntries } from "./native-project-pixel-inputs.mjs";

test("native witness manifests share the catalog without changing profiles or repair ownership", async () => {
  const root = process.cwd(),
    manifestPath = join(root, "artifacts", "witness", "frames.json");
  const manifest = {
    schema_version: 1,
    kind: "native-project-export-witness",
    frames: [
      {
        case_id: "example",
        frame: 0,
        path: "0/candidate.png",
        png_sha256: "a".repeat(64),
        profile: "exact",
      },
    ],
  };
  const repairs = {};
  const inputs = {
    context: { root },
    ledger: {},
    corpus: { cases: [{ id: "example", frames: [0, 2], tolerance: "gpu" }] },
    catalog: {},
    repairs,
    json: async () => structuredClone(manifest),
    loadReferenceCatalog: () => {
      throw new Error("Authenticated catalog must not be reset");
    },
  };
  const entries = await projectPixelEntries(root, manifestPath, inputs);
  assert.equal(entries[0].profile, "gpu");
  assert.equal(entries[0].path, join(root, "artifacts", "witness", "0", "candidate.png"));
  assert.equal(inputs.repairs, repairs);
  for (const mutate of [
    (m) => {
      m.kind = "ts-candidate";
    },
    (m) => {
      m.frames = [];
    },
    (m) => {
      m.frames.push({ ...m.frames[0] });
    },
    (m) => {
      m.frames[0].case_id = "other";
    },
    (m) => {
      m.frames[0].frame = 1;
    },
    (m) => {
      m.frames[0].png_sha256 = "bad";
    },
    (m) => {
      m.frames[0].path = "../outside.png";
    },
    (m) => {
      m.frames[0].path = join(root, "outside.png");
    },
  ]) {
    const changed = structuredClone(manifest);
    mutate(changed);
    await assert.rejects(
      projectPixelEntries(root, manifestPath, { ...inputs, json: async () => changed }),
    );
  }
});
