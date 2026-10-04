import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadIrRuntime } from "../migration/ir-gate-runtime.mjs";
import { RasterCaptureStore, validateCapturedRaster } from "./raster-capture.mjs";

test("raster capture binds actual pixel/replay bytes and rejects corrupt or missing evidence", async (t) => {
  const runtime = await loadIrRuntime(process.cwd());
  t.after(() => runtime.close());
  const directory = await mkdtemp(join(tmpdir(), "aster-raster-capture-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const fixture = (await runtime.rasterPixelFixtures())[0];
  const messages = [fixture.source, fixture.frame, fixture.message];
  const pixels = Buffer.from(fixture.bytes);
  const corrupt = Buffer.from(pixels);
  corrupt[3] ^= 1;
  assert.throws(
    () => validateCapturedRaster(messages, pixels, corrupt),
    /GPU replay pixels differ/,
  );
  assert.throws(() => validateCapturedRaster(messages, corrupt, corrupt), /resource hash mismatch/);
  const store = new RasterCaptureStore();
  const hash = fixture.message.hash;
  assert.deepEqual(
    await store.write(directory, "case", {
      references: [hash],
      resources: [{ messages, pixels, replay: pixels }],
    }),
    [hash],
  );
  assert.deepEqual(await readFile(join(directory, "raster-resources", `${hash}.bin`)), pixels);
  assert.equal(store.records("case")[0].pixels_sha256, store.records("case")[0].replay_sha256);
  await store.write(directory, "case", { references: [hash], resources: [] });
  assert.equal(store.records("case").length, 1);
  await assert.rejects(
    store.write(directory, "case", { references: ["0".repeat(64)], resources: [] }),
    /uncaptured raster/,
  );
});
