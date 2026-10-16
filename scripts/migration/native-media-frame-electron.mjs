import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { app, BrowserWindow } from "electron";
import { validateFrameResource } from "../parity/frame-artifacts.mjs";
import { encodeRgbaPng } from "../parity/png.mjs";
import { writeAtomicJson } from "./report.mjs";

const config = JSON.parse(readFileSync(process.env.ASTER_MEDIA_FRAME_CONFIG, "utf8"));
app.setPath("userData", join(config.output, "profile"));
for (const flag of [
  "force_high_performance_gpu",
  "disable-background-timer-throttling",
  "disable-renderer-backgrounding",
  "disable-backgrounding-occluded-windows",
])
  app.commandLine.appendSwitch(flag);
const report = { status: "failed", source: config.source, frames: [] };
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const local = (path) => relative(config.root, path).replaceAll("\\", "/");
let window;
async function main() {
  try {
    await app.whenReady();
    console.log("capture: app ready");
    window = new BrowserWindow({
      show: false,
      webPreferences: {
        backgroundThrottling: false,
        paintWhenInitiallyHidden: true,
      },
    });
    window.webContents.on("console-message", (_event, _level, message) => console.log(message));
    await window.loadURL(config.url);
    console.log("capture: runtime loaded");
    const catalog = JSON.parse(
      await readFile(join(config.root, "tests/parity/assets/media-assets.json"), "utf8"),
    );
    const assets = Object.fromEntries(
      ["pattern.png", "barcode-24000-1001.mp4"].map((name) => [name, catalog.assets[name]]),
    );
    if (config.videoOverride) {
      const bytes = await readFile(config.videoOverride);
      assets["barcode-24000-1001.mp4"] = {
        ...assets["barcode-24000-1001.mp4"],
        data: bytes.toString("base64"),
        sha256: sha(bytes),
      };
      report.video_override_sha256 = sha(bytes);
    }
    const results = await window.webContents.executeJavaScript(
      `window.captureMixedMedia(${JSON.stringify(assets)}, ${config.jobCapture === true})`,
    );
    assert.equal(results.length, 6);
    report.gpu_info = await app.getGPUInfo("complete");
    const resources = join(config.output, "resources");
    await mkdir(resources);
    const known = new Set();
    for (const result of results) {
      const { plan: input, replay: captured, rgba, resources: packets, ...proof } = result;
      assert(proof.independent_device_exact && proof.temporal.passes > 0);
      assert(proof.plan_only_exact && proof.plan_only_final_output_accesses === 0);
      assert(proof.plan_only_repeat_exact);
      assert.equal(proof.plan_only_file_pixel_captures, 0);
      const dir = join(config.output, proof.id);
      await mkdir(dir);
      const plan = Buffer.from(input),
        replay = Buffer.from(captured),
        pixels = Buffer.from(rgba);
      const metadata = JSON.parse(plan.subarray(32, 32 + plan.readUInt32LE(8)));
      const records = [];
      for (const packet of packets) {
        const bytes = Buffer.from(packet.bytes);
        validateFrameResource(packet.message, bytes);
        if (!known.has(packet.message.hash)) {
          await writeFile(join(resources, `${packet.message.hash}.bin`), bytes, { flag: "wx" });
          known.add(packet.message.hash);
        }
        records.push({ message: packet.message, sha256: sha(bytes) });
      }
      const messages = records.map((r) => r.message);
      const original = messages.filter((m) => metadata.resources.includes(m.hash));
      assert.deepEqual(original.map((m) => m.hash).sort(), metadata.resources);
      await writeAtomicJson(join(dir, "resources.json"), original);
      await writeAtomicJson(join(dir, "replay-resources.json"), messages);
      const png = encodeRgbaPng(proof.width, proof.height, pixels);
      await writeFile(join(dir, "plan.fpln"), plan, { flag: "wx" });
      await writeFile(join(dir, "replay.fpln"), replay, { flag: "wx" });
      await writeFile(join(dir, "reference.png"), png, { flag: "wx" });
      report.frames.push({
        ...proof,
        resources: records,
        plan: { path: local(join(dir, "plan.fpln")), sha256: sha(plan) },
        replay: { path: local(join(dir, "replay.fpln")), sha256: sha(replay) },
        reference: {
          path: local(join(dir, "reference.png")),
          sha256: sha(png),
          rgba_sha256: sha(pixels),
        },
      });
    }
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
