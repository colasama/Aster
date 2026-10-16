import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import { runNativeMediaFrameGate } from "./native-media-frame-gate.mjs";
import { runStep } from "./process.mjs";
import { writeAtomicJson } from "./report.mjs";
import { hashFile, sourceProvenance } from "./source.mjs";

const { values } = parseArgs({ options: { out: { type: "string" } } });
assert(values.out, "--out is required");
const root = process.cwd(),
  output = resolve(values.out);
await mkdir(output, { recursive: true });
const context = { root, output, env: process.env };
const report = { status: "failed", steps: [] };
try {
  report.source = await sourceProvenance(root);
  const catalog = JSON.parse(
    await readFile(join(root, "tests/parity/assets/media-assets.json"), "utf8"),
  );
  const name = "barcode-24000-1001.mp4";
  const original = join(output, "tagged.mp4"),
    untagged = join(output, "untagged.mp4");
  await writeFile(original, Buffer.from(catalog.assets[name].data, "base64"), { flag: "wx" });
  assert.equal(await hashFile(original), catalog.assets[name].sha256);
  const strip = await runStep(
    {
      id: "strip-tags",
      file: join(root, "build/ffmpeg/ffmpeg.exe"),
      args: [
        "-v",
        "error",
        "-i",
        original,
        "-map",
        "0:v:0",
        "-c:v",
        "copy",
        "-bsf:v",
        "h264_metadata=colour_primaries=2:transfer_characteristics=2:matrix_coefficients=2",
        "-color_primaries",
        "unknown",
        "-color_trc",
        "unknown",
        "-colorspace",
        "unknown",
        untagged,
      ],
    },
    context,
  );
  report.steps.push(strip);
  assert.equal(strip.status, "passed");
  const probe = await runStep(
    {
      id: "probe-tags",
      file: join(root, "build/ffmpeg/ffprobe.exe"),
      args: ["-v", "error", "-show_streams", "-of", "json", untagged],
    },
    context,
  );
  report.steps.push(probe);
  assert.equal(probe.status, "passed");
  const probeText = await readFile(join(root, probe.log), "utf8");
  report.video = JSON.parse(probeText.slice(probeText.indexOf("\n") + 1)).streams[0];
  assert.equal(report.video.codec_name, "h264");
  assert.equal(report.video.pix_fmt, "yuv420p");
  for (const key of ["color_primaries", "color_transfer", "color_space"])
    assert([undefined, "unknown"].includes(report.video[key]));
  const captureDir = join(output, "capture");
  const capture = await runStep(
    {
      id: "capture",
      file: "node",
      args: ["scripts/migration/native-media-frame-capture.mjs", captureDir],
      env: { ASTER_NATIVE_VIDEO_OVERRIDE: untagged, ASTER_NATIVE_JOB_CAPTURE: "0" },
      timeout_ms: 300000,
    },
    context,
  );
  report.steps.push(capture);
  assert.equal(capture.status, "passed");
  catalog.assets[name] = {
    ...catalog.assets[name],
    data: (await readFile(untagged)).toString("base64"),
    sha256: await hashFile(untagged),
  };
  const reference = {
    path: relative(root, join(captureDir, "report.json")).replaceAll("\\", "/"),
    sha256: await hashFile(join(captureDir, "report.json")),
  };
  report.reference = reference;
  report.pixels = await runNativeMediaFrameGate(
    { ...context, output: join(output, "pixels") },
    {
      binary: join(root, "target/release/aster-render-cli.exe"),
      compiler: join(root, "node_modules/electron/dist/dxcompiler.dll"),
      reference,
      mediaCatalog: catalog,
      casePrefix: "native-untagged-media-frame",
    },
  );
  assert.equal((await sourceProvenance(root)).source_sha256, report.source.source_sha256);
  assert.equal(report.pixels.frames.length, 6);
  for (const frame of report.pixels.frames)
    assert.equal(
      frame.receipt.native_videos[0].color_interpretation,
      "untagged SD: SMPTE 170M limited",
    );
  assert.equal(report.pixels.status, "passed", report.pixels.error);
  report.status = "passed";
} catch (error) {
  report.error = error.stack ?? String(error);
}
await writeAtomicJson(join(output, "report.json"), report);
console.log(JSON.stringify({ status: report.status, error: report.error }));
process.exitCode = report.status === "passed" ? 0 : 1;
