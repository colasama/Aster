import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readPlanProjectSnapshot, writePlanProjectSnapshot } from "./plan-project-snapshot.mjs";

test("owner snapshots stay outside the checkout and bind their exact external location", async (t) => {
  const base = await mkdtemp(join(tmpdir(), "aster-plan-snapshot-test-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = join(base, "checkout"),
    external = join(base, "external");
  await mkdir(root);
  await mkdir(external);
  const config = { root, runDirectory: join(root, "run"), ownerSnapshotDirectory: external };
  const item = { id: "owner-main", project: "env:ASTER_PERF_PROJECT" };
  const bytes = Buffer.from('{"private":"owner project"}');
  const location = await writePlanProjectSnapshot(config, item, bytes);
  assert.deepEqual(await readdir(root), []);
  assert.equal(location.kind, "owner-external");
  const capture = { project_snapshot: location };
  const local = () => assert.fail("Owner snapshot must not read from the checkout");
  assert.deepEqual(await readPlanProjectSnapshot(config, item, capture, local), bytes);
  await assert.rejects(writePlanProjectSnapshot(config, item, bytes), { code: "EEXIST" });
  await assert.rejects(readPlanProjectSnapshot(config, item, {}, local));
  const other = join(external, "other.json");
  await writeFile(other, bytes);
  await assert.rejects(
    readPlanProjectSnapshot(
      config,
      item,
      { project_snapshot: { ...location, path: other } },
      local,
    ),
  );
  await assert.rejects(
    writePlanProjectSnapshot({ ...config, ownerSnapshotDirectory: root }, item, bytes),
    /outside the checkout/,
  );
  await assert.rejects(
    writePlanProjectSnapshot({ ...config, ownerSnapshotDirectory: undefined }, item, bytes),
  );
  assert.deepEqual(await readdir(root), []);
});

test("fixture snapshots remain local and cannot redirect to owner storage", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "aster-plan-fixture-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = { root, runDirectory: join(root, "run") };
  const item = { id: "fixture", project: "tests/fixture.json" };
  const directory = join(config.runDirectory, "pending", item.id);
  await mkdir(directory, { recursive: true });
  const bytes = Buffer.from('{"fixture":true}');
  assert.equal(await writePlanProjectSnapshot(config, item, bytes), undefined);
  const read = (name) => readFile(join(directory, name));
  assert.deepEqual(await readPlanProjectSnapshot(config, item, {}, read), bytes);
  await assert.rejects(
    readPlanProjectSnapshot(config, item, { project_snapshot: { kind: "owner-external" } }, read),
  );
});
