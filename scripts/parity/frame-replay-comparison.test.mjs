import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { compareFrameReplay } from "./frame-replay-comparison.mjs";
import { decodeRgbaPng } from "./png.mjs";

test("whole-frame replay records equality and preserves rejected source pixels", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "aster-frame-replay-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const production = new Uint8Array([12, 30, 40, 255, 1, 2, 3, 0]);
  const payload = {
    caseId: "fixture",
    frame: 2,
    width: 2,
    height: 1,
    productionPixels: production.buffer,
  };
  const accepted = await compareFrameReplay(directory, payload, production);
  assert.equal(accepted.exact, true);
  assert.equal(accepted.production_sha256, accepted.replay_sha256);
  const changed = production.slice();
  changed[1]++;
  await assert.rejects(compareFrameReplay(directory, payload, changed), /1 bytes differ/);
  const path = join(directory, "replay-mismatches", "fixture", "2");
  assert.deepEqual(
    decodeRgbaPng(await readFile(join(path, "production.png"))).pixels,
    Buffer.from(production),
  );
  assert.deepEqual(
    decodeRgbaPng(await readFile(join(path, "replay.png"))).pixels,
    Buffer.from(changed),
  );
  assert.equal(JSON.parse(await readFile(join(path, "comparison.json"), "utf8")).exact, false);
});
