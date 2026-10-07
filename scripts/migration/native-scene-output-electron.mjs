import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { app, BrowserWindow } from "electron";
import { validateFrameResource } from "../parity/frame-artifacts.mjs";
import { encodeRgbaPng } from "../parity/png.mjs";
import { writeAtomicJson } from "./report.mjs";

const config = JSON.parse(readFileSync(process.env.ASTER_SURFACE_FRAME_CONFIG, "utf8"));
app.setPath("userData", join(config.output, "profile"));
for (const flag of [
  "force_high_performance_gpu",
  "disable-background-timer-throttling",
  "disable-renderer-backgrounding",
  "disable-backgrounding-occluded-windows",
])
  app.commandLine.appendSwitch(flag);
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const local = (p) => relative(config.root, p).replaceAll("\\", "/");
const report = { status: "failed", source: config.source, frames: [], controls: [] };
let window;
async function main() {
  try {
    await app.whenReady();
    window = new BrowserWindow({
      show: false,
      webPreferences: { backgroundThrottling: false, paintWhenInitiallyHidden: true },
    });
    await window.loadURL(config.url);
    const frames = JSON.parse(await readFile(join(config.output, "inputs.json"), "utf8"));
    assert.equal(frames.length, 64);
    const render = () =>
      window.webContents.executeJavaScript(`window.renderSurfaceFrames(${JSON.stringify(frames)})`);
    const results = await render();
    await window.loadURL(`${config.url}?repeat=1`);
    assert.deepEqual(await render(), results, "Independent TS devices differ");
    const resources = join(config.output, "resources");
    await mkdir(resources);
    const known = new Set();
    for (const [index, frame] of frames.entries()) {
      const { plan, resources: packets, ...proof } = frame;
      assert.equal(results[index].id, proof.id);
      const pixels = Buffer.from(results[index].pixels);
      assert.equal(pixels.length, proof.width * proof.height * 4);
      const dir = join(config.output, proof.id);
      await mkdir(dir);
      const bytes = Buffer.from(plan),
        metadata = JSON.parse(bytes.subarray(32, 32 + bytes.readUInt32LE(8)));
      const used = packets.filter((r) => metadata.resources.includes(r.message.hash));
      assert.deepEqual(used.map((r) => r.message.hash).sort(), metadata.resources);
      const records = [];
      for (const r of used) {
        const data = Buffer.from(r.bytes);
        validateFrameResource(r.message, data);
        const path = join(resources, `${r.message.hash}.bin`);
        if (!known.has(r.message.hash)) {
          await writeFile(path, data, { flag: "wx" });
          known.add(r.message.hash);
        }
        records.push({ message: r.message, path: local(path), sha256: sha(data) });
      }
      await writeAtomicJson(
        join(dir, "resources.json"),
        records.map((r) => r.message),
      );
      const png = encodeRgbaPng(proof.width, proof.height, pixels);
      await writeFile(join(dir, "plan.fpln"), bytes, { flag: "wx" });
      await writeFile(join(dir, "reference.png"), png, { flag: "wx" });
      report.frames.push({
        ...proof,
        repeated_exact: true,
        plan: { path: local(join(dir, "plan.fpln")), sha256: sha(bytes) },
        reference: {
          path: local(join(dir, "reference.png")),
          sha256: sha(png),
          rgba_sha256: sha(pixels),
        },
        resources: records,
      });
    }
    for (const aa of ["off", "fxaa", "ssaa2x", "ssaa4x"]) {
      for (const [a, b] of [
        ["k0-still-ready", "k1-still-ready"],
        ["k1-still-ready", "k2-still-ready"],
        ["k0-still-ready", "k0-motion-ready"],
        ["k0-still-ready", "k0-still-skipped"],
      ]) {
        const left = results.find((r) => r.id === `depthOfField-${aa}-${a}`),
          right = results.find((r) => r.id === `depthOfField-${aa}-${b}`);
        const changed = left.pixels.reduce((n, v, i) => n + Number(v !== right.pixels[i]), 0);
        assert(changed > 16, `Output control has no observable effect: ${aa}/${a}/${b}`);
        report.controls.push({ aa, a, b, changed_bytes: changed });
      }
    }
    report.gpu_info = await app.getGPUInfo("complete");
    report.status = "passed";
  } catch (error) {
    report.error = error.stack ?? error.message;
  } finally {
    await writeAtomicJson(join(config.output, "report.json"), report);
    window?.destroy();
    app.exit(report.status === "passed" ? 0 : 1);
  }
}
void main();
