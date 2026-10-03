import assert from "node:assert/strict";
import { cp, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { repairFixture } from "../migration/m0-reference-repairs-fixtures.mjs";
import { PixelInputs } from "./pixel-inputs.mjs";
import { digest } from "./provenance.mjs";

test("PixelInputs applies only the reviewed requested frame and preserves original sequence neighbors", async (t) => {
  const data = await repairFixture(t);
  await mkdir(join(data.root, "artifacts", "parity"), { recursive: true });
  await cp(join(data.root, "refs"), join(data.root, "artifacts", "parity", "reference"), {
    recursive: true,
  });
  data.ledger.reference_baseline = { renderer_source_sha256: "a".repeat(64) };
  await data.json("docs/migration/rust-renderer-progress.json", data.ledger);
  const repair = data.ledger.reference_repairs[0];
  const replacement = `${repair.directory}/sequence/1/frame.png`;
  await data.write("candidate/frame.png", await readFile(join(data.root, replacement)));
  await data.json("candidate/manifest.json", {
    schema_version: 1,
    kind: "ts-candidate",
    run_id: "independent-capture",
    frames: [
      {
        case_id: "sequence",
        frame: 1,
        path: "frame.png",
        png_sha256: await data.hash(replacement),
      },
    ],
  });
  const original = "artifacts/parity/reference/sequence/1/frame.png";
  const originalHash = await data.hash(original);
  const inputs = new PixelInputs({ root: data.root });
  const [entry] = await inputs.load(join(data.root, "candidate", "manifest.json"), "full", "exact");
  const prepared = await inputs.prepare(entry);
  assert.equal(prepared.reference.path, join(data.root, replacement));
  assert.equal(prepared.reference.meta.renderer_source_sha256, repair.renderer_source_sha256);
  assert.equal(prepared.reference.meta.run_id, "repair-run");
  for (const [side, frame] of [
    ["previous", 0],
    ["next", 2],
  ]) {
    const neighbor = prepared.neighbors[side];
    assert.equal(
      neighbor.path,
      join(data.root, "artifacts", "parity", "reference", "sequence", String(frame), "frame.png"),
    );
    assert.equal(neighbor.meta.renderer_source_sha256, "a".repeat(64));
    assert.equal(neighbor.meta.run_id, "older-run");
  }
  const binding = inputs.referenceBinding();
  assert.equal(binding.base_renderer_source_sha256, "a".repeat(64));
  assert.equal(binding.repairs_sha256, digest(data.ledger.reference_repairs));
  assert.equal(binding.repairs.length, 1);
  assert.equal(binding.repairs[0].run_id, "repair-run");
  assert.equal(await data.hash(original), originalHash);
  assert((await inputs.verifyStable()) > 0);
});
