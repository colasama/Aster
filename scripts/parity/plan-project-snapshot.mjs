import assert from "node:assert/strict";
import { lstat, readFile, realpath, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";

/** Owner project snapshots stay outside the checkout; corpus fixtures remain self-contained. */
export async function planProjectSnapshot(config, item) {
  assert(/^[a-z0-9-]+$/.test(item.id), "Unsafe plan snapshot case id");
  if (item.project !== "env:ASTER_PERF_PROJECT")
    return { kind: "fixture", path: join(config.runDirectory, "pending", item.id, "project.json") };
  assert(config.ownerSnapshotDirectory, "Owner plan snapshots require external storage");
  const directory = await realpath(config.ownerSnapshotDirectory);
  const member = relative(await realpath(config.root), directory);
  assert(
    member === ".." || member.startsWith(`..${sep}`) || isAbsolute(member),
    "Owner project snapshots must remain outside the checkout",
  );
  assert((await lstat(directory)).isDirectory());
  return { kind: "owner-external", path: join(directory, `${item.id}.json`) };
}

export async function writePlanProjectSnapshot(config, item, bytes) {
  const location = await planProjectSnapshot(config, item);
  await writeFile(location.path, bytes, { flag: "wx" });
  return location.kind === "owner-external" ? location : undefined;
}

export async function readPlanProjectSnapshot(config, item, capture, readLocal) {
  if (item.project !== "env:ASTER_PERF_PROJECT") {
    assert.equal(capture.project_snapshot, undefined);
    return readLocal("project.json");
  }
  const expected = await planProjectSnapshot(config, item);
  assert.deepEqual(capture.project_snapshot, expected, "Owner snapshot location changed");
  const path = await realpath(expected.path);
  assert.equal(relative(expected.path, path), "", "Owner snapshot escaped external storage");
  assert((await lstat(path)).isFile());
  return readFile(path);
}
