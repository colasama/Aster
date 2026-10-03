import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { captureAssignments, captureFrames } from "./provenance.mjs";

test("identity neighbors are actual adjacent frames and preserve the requested seek order", () => {
  const composition = { duration: 5, frameRate: { numerator: 2, denominator: 1 } };
  assert.deepEqual(
    captureFrames({ sequence: true, frames: [7, 0, 9, 3] }, composition),
    [7, 0, 9, 3, 6, 8, 1, 2, 4],
  );
  assert.deepEqual(captureFrames({ frames: [7, 0] }, composition), [7, 0]);
});

test("external asset content changes invalidate the case while owner sources remain external", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "aster-parity-provenance-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const owner = join(root, "owner");
  await mkdir(join(owner, "assets"), { recursive: true });
  await writeFile(
    join(owner, "project.json"),
    JSON.stringify({
      compositions: [{ id: "main", duration: 1, frameRate: { numerator: 30, denominator: 1 } }],
    }),
  );
  await writeFile(join(owner, "assets", "asset.bin"), "first");
  const cases = [
    { id: "owner", project: "env:ASTER_PERF_PROJECT", composition: "main", frames: [0] },
  ];
  const first = await captureAssignments(root, cases, { ASTER_PERF_PROJECT: owner });
  assert.equal(first[0].projectPath, owner);
  assert.equal(first[0].inputs.assets.length, 1);
  assert(!("project" in first[0]), "Provenance must not copy the owner document");
  await writeFile(join(owner, "assets", "asset.bin"), "other");
  const next = await captureAssignments(root, cases, { ASTER_PERF_PROJECT: owner });
  assert.notEqual(first[0].caseHash, next[0].caseHash);
  const missing = await captureAssignments(root, cases, {});
  assert.equal(missing[0].unavailable, "ASTER_PERF_PROJECT is not set");
});

test("authorized files outside assets are hashed and opaque runtime URLs are rejected", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "aster-parity-locators-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = {
    compositions: [{ id: "main", duration: 1, frameRate: { numerator: 30, denominator: 1 } }],
    sources: [{ relativePath: "plate.png" }],
  };
  await writeFile(join(root, "project.json"), JSON.stringify(project));
  await writeFile(join(root, "plate.png"), "first");
  const cases = [{ id: "still", project: "project.json", composition: "main", frames: [0] }];
  const first = await captureAssignments(root, cases);
  await writeFile(join(root, "plate.png"), "changed");
  const changed = await captureAssignments(root, cases);
  assert.notEqual(first[0].caseHash, changed[0].caseHash);
  assert.equal(first[0].inputs.referenced_files[0].path, "plate.png");
  project.sources = [{ runtimeUrl: "https://example.test/unhashed.png" }];
  await writeFile(join(root, "project.json"), JSON.stringify(project));
  await assert.rejects(captureAssignments(root, cases), /runtime URLs/);
});
