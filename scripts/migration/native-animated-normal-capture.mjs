import assert from "node:assert/strict";
import { normalFixtures } from "./native-normal-fixtures.mjs";
import { captureSuppliedFrames } from "./supplied-frame-capture.mjs";

assert.equal(process.argv.length, 4, "Expected encoded capture and output directories");
const frames = await normalFixtures(process.cwd(), process.argv[2], true);
const controls = frames
  .filter((f) => f.mode === "normal")
  .map((f) => ({
    light: f.light,
    aa: f.aa,
    variant: f.variant,
    left: f.id,
    right: f.id.replace(/-normal$/, "-zero"),
  }));
await captureSuppliedFrames(frames, process.argv[3], controls);
