import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { runStep } from "./migration/process.mjs";
import { writeAtomicJson } from "./migration/report.mjs";
import { hashFile, sourceProvenance } from "./migration/source.mjs";
import { nativeReleaseBuild } from "./native-build.mjs";
import { runPixelGate } from "./parity/pixel-gate.mjs";
import { decodeRgbaPng, encodeRgbaPng } from "./parity/png.mjs";

if (process.argv.length !== 2) throw new Error("parity:oracle takes no arguments");
const root = resolve(import.meta.dirname, "..");
const id = `${new Date().toISOString().replaceAll(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
const output = join(root, "artifacts", "parity", "oracle", id);
await mkdir(output, { recursive: true });
const context = { root, output, env: process.env, print: console.log };
const report = { schema_version: 1, id, status: "failed", started_at: new Date().toISOString() };
try {
  const build = await runStep(nativeReleaseBuild("compare-build"), context);
  assert.equal(build.status, "passed", "Comparison CLI build failed");
  report.source = await sourceProvenance(root);
  const reference = join(root, "artifacts/parity/reference/shape-ellipse/0/frame.png");
  const referenceHash = await hashFile(reference);
  const image = decodeRgbaPng(await readFile(reference));
  assert.equal(image.width, 320);
  assert.equal(image.height, 180);
  let changedPixels = 0;
  for (let y = 70; y < 90; y++) {
    for (let x = 145; x < 165; x++) {
      const offset = (y * image.width + x) * 4;
      if (image.pixels.subarray(offset, offset + 4).some((value) => value !== 0)) changedPixels++;
      image.pixels.fill(0, offset, offset + 4);
    }
  }
  assert.equal(changedPixels, 400, "The rejection probe must remove 400 visible pixels");
  const candidate = join(output, "missing-patch.png");
  await writeFile(join(output, "exact-positive.png"), await readFile(reference), { flag: "wx" });
  await writeFile(candidate, encodeRgbaPng(image.width, image.height, image.pixels), {
    flag: "wx",
  });
  report.perturbation = {
    case_id: "shape-ellipse",
    frame: 0,
    rectangle: [145, 70, 20, 20],
    changed_pixels: changedPixels,
    replacement_rgba: [0, 0, 0, 0],
  };
  const positiveManifest = join(output, "positive.json");
  const negativeManifest = join(output, "negative.json");
  await writeAtomicJson(positiveManifest, {
    schema_version: 1,
    frames: [
      { case_id: "shape-ellipse", frame: 0, path: "exact-positive.png", png_sha256: referenceHash },
    ],
  });
  await writeAtomicJson(negativeManifest, {
    schema_version: 1,
    frames: [
      {
        case_id: "shape-ellipse",
        frame: 0,
        path: "missing-patch.png",
        png_sha256: await hashFile(candidate),
      },
    ],
  });
  report.positive = await runPixelGate(
    { ...context, output: join(output, "positive") },
    { manifestPath: positiveManifest, scope: "diagnostic", profileOverride: "exact" },
  );
  report.negative = await runPixelGate(
    { ...context, output: join(output, "negative") },
    { manifestPath: negativeManifest, scope: "diagnostic", profileOverride: "gpu" },
  );
  await writeAtomicJson(join(output, "positive-g3.json"), report.positive);
  await writeAtomicJson(join(output, "negative-g3.json"), report.negative);
  assert.equal(report.positive.status, "passed", "Exact identity must pass G3");
  assert.equal(report.negative.status, "failed", "The missing patch must fail G3");
  const comparison = JSON.parse(
    await readFile(join(output, "negative", "frames", "shape-ellipse-0", "report.json"), "utf8"),
  );
  assert.equal(comparison.comparison.passed, false);
  assert.equal(comparison.comparison.structural.largest_error_component, 400);
  assert(
    comparison.comparison.checks.some((check) => check.id === "error_clusters" && !check.passed),
  );
  assert(
    comparison.comparison.checks.some((check) => check.id === "alpha_coverage" && !check.passed),
  );
  assert.equal(await hashFile(reference), referenceHash, "Oracle proof changed the reference");
  report.source_after = await sourceProvenance(root);
  report.source_unchanged = report.source.source_sha256 === report.source_after.source_sha256;
  assert(report.source_unchanged, "Source changed during the oracle proof");
  report.status = "passed";
} catch (error) {
  report.error = error.stack ?? error.message;
}
report.finished_at = new Date().toISOString();
await writeAtomicJson(join(output, "report.json"), report);
console.log(
  `Oracle rejection proof: ${report.status}\nReport: ${relative(root, join(output, "report.json"))}`,
);
process.exitCode = report.status === "passed" ? 0 : 1;
