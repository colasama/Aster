import assert from "node:assert/strict";
import { sceneOutputFixtures } from "./native-scene-output-fixtures.mjs";
import { captureSuppliedFrames } from "./supplied-frame-capture.mjs";

assert.equal(process.argv.length, 3, "Expected capture output directory");
const controls = ["off", "fxaa", "ssaa2x", "ssaa4x"].flatMap((aa) =>
  [
    ["k0-still-ready", "k1-still-ready"],
    ["k1-still-ready", "k2-still-ready"],
    ["k0-still-ready", "k0-motion-ready"],
    ["k0-still-ready", "k0-still-skipped"],
  ].map(([a, b]) => ({
    aa,
    a,
    b,
    left: `depthOfField-${aa}-${a}`,
    right: `depthOfField-${aa}-${b}`,
  })),
);
await captureSuppliedFrames(await sceneOutputFixtures(process.cwd()), process.argv[2], controls);
