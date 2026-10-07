import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { app, BrowserWindow } from "electron";
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
const report = { status: "failed", frames: [] };
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
    const results = await window.webContents.executeJavaScript(
      `window.renderSurfaceFrames(${JSON.stringify(frames)})`,
    );
    await window.loadURL(`${config.url}?repeat=1`);
    const repeated = await window.webContents.executeJavaScript(
      `window.renderSurfaceFrames(${JSON.stringify(frames)})`,
    );
    assert.deepEqual(results, repeated, "Independent TS devices differ");
    assert.equal(results.length, frames.length);
    for (const [index, frame] of frames.entries()) {
      const result = results[index];
      assert.equal(result.id, frame.id);
      const bytes = Buffer.from(result.pixels);
      assert.equal(bytes.length, frame.width * frame.height * 4);
      assert(bytes.some((b) => b !== 0));
      const path = `${frame.id}.png`;
      await writeFile(join(config.output, path), encodeRgbaPng(frame.width, frame.height, bytes), {
        flag: "wx",
      });
      report.frames.push({
        id: frame.id,
        width: frame.width,
        height: frame.height,
        path,
        rgba_sha256: createHash("sha256").update(bytes).digest("hex"),
        repeated_exact: true,
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
