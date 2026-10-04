import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { encodeRgbaPng } from "../parity/png.mjs";
import { loadIrRuntime } from "./ir-gate-runtime.mjs";
import { validateTemporalOutput } from "./temporal-text-evidence.mjs";

test("temporal evidence rejects changed pixels, replay, shutter samples and frozen references", async (t) => {
  const runtime = await loadIrRuntime(process.cwd());
  t.after(() => runtime.close());
  const fixture = (await runtime.rasterPixelFixtures())[0];
  const pixels = Buffer.from(fixture.bytes);
  const messages = structuredClone([fixture.source, fixture.frame, fixture.message]);
  messages[0].descriptor.authorization_scope = "temporal-gpu";
  messages[0].hash = await runtime.contentResourceHash(messages[0]);
  messages[1].descriptor.source = messages[0].hash;
  messages[1].hash = await runtime.contentResourceHash(messages[1]);
  messages[2].descriptor.frame = messages[1].hash;
  messages[2].hash = await runtime.contentResourceHash(messages[2], pixels);
  const { width, height } = messages[1].descriptor;
  const png = encodeRgbaPng(width, height, pixels);
  const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
  const expected = {
    mode: "full",
    width,
    height,
    samples: 8,
    transparent_weight: 0,
    png_sha256: sha(png),
    rgba_sha256: sha(pixels),
  };
  const actual = { ...expected, messages, pixels, replay: pixels };
  assert.equal(validateTemporalOutput(actual, expected, png).exact, true);
  const changed = Buffer.from(pixels);
  changed[0] ^= 1;
  assert.throws(
    () => validateTemporalOutput({ ...actual, pixels: changed }, expected, png),
    /pixels differ/,
  );
  assert.throws(
    () => validateTemporalOutput({ ...actual, replay: changed }, expected, png),
    /replay differs/,
  );
  assert.throws(
    () => validateTemporalOutput({ ...actual, samples: 0 }, expected, png),
    /samples differs/,
  );
  assert.throws(
    () => validateTemporalOutput(actual, expected, encodeRgbaPng(width, height, changed)),
    /PNG changed/,
  );
});
