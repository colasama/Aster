import assert from "node:assert/strict";
import { materialFixtures } from "./native-material-fixtures.mjs";
import { captureSuppliedFrames } from "./supplied-frame-capture.mjs";

assert.equal(process.argv.length, 3, "Expected capture output directory");
const controls = ["directional", "point", "spot"].flatMap((light) =>
  ["off", "fxaa", "ssaa2x", "ssaa4x"].flatMap((aa) =>
    [
      ["fallback", "hdr"],
      ["hdr", "rotated"],
      ["hdr", "replaced"],
      ...(light === "point" ? [] : [["fallback", "unshadowed"]]),
    ].map(([a, b]) => ({
      light,
      aa,
      a,
      b,
      left: `${light}-${aa}-${a}`,
      right: `${light}-${aa}-${b}`,
    })),
  ),
);
await captureSuppliedFrames(await materialFixtures(process.cwd()), process.argv[2], controls);
