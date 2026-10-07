import assert from "node:assert/strict";
import { normalFixtures } from "./native-normal-fixtures.mjs";
import { captureSuppliedFrames } from "./supplied-frame-capture.mjs";

assert.equal(process.argv.length, 4, "Expected encoded capture and output directories");
const controls = ["directional", "point", "spot"].flatMap((light) =>
  ["off", "fxaa", "ssaa2x", "ssaa4x"].flatMap((aa) =>
    ["png", "jpeg", "webp"].flatMap((encoding) =>
      [
        ["normal", "negative"],
        ["normal", "zero"],
        ["normal", "combined"],
      ].map(([a, b]) => ({
        light,
        aa,
        encoding,
        a,
        b,
        left: `${light}-${aa}-${encoding}-${a}`,
        right: `${light}-${aa}-${encoding}-${b}`,
      })),
    ),
  ),
);
await captureSuppliedFrames(
  await normalFixtures(process.cwd(), process.argv[2]),
  process.argv[3],
  controls,
);
