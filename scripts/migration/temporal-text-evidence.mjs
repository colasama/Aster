import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { decodeRgbaPng } from "../parity/png.mjs";
import { validateCapturedRaster } from "../parity/raster-capture.mjs";

export function validateTemporalOutput(actual, reference, png) {
  const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
  for (const field of ["mode", "width", "height", "samples", "transparent_weight"])
    assert.equal(actual[field], reference[field], `Temporal ${field} differs`);
  assert.equal(sha(png), reference.png_sha256, "Frozen temporal PNG changed");
  const expected = decodeRgbaPng(png);
  assert.equal(expected.width, reference.width);
  assert.equal(expected.height, reference.height);
  assert.equal(sha(expected.pixels), reference.rgba_sha256);
  const pixels = Buffer.from(actual.pixels);
  const replay = Buffer.from(actual.replay);
  assert(pixels.equals(expected.pixels), `Temporal ${reference.mode} pixels differ`);
  assert(replay.equals(pixels), "Temporal GPU replay differs");
  const resource = validateCapturedRaster(actual.messages, pixels, replay);
  assert.equal(actual.messages[1].descriptor.width, actual.width);
  assert.equal(actual.messages[1].descriptor.height, actual.height);
  assert.equal(resource.origin, "text");
  assert.equal(actual.messages[0].descriptor.authorization_scope, "temporal-gpu");
  return {
    mode: reference.mode,
    samples: actual.samples,
    transparent_weight: actual.transparent_weight,
    width: actual.width,
    height: actual.height,
    bytes: pixels.length,
    exact: true,
    exact_gpu_replay: true,
    ...resource,
  };
}
