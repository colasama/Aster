import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { app, BrowserWindow } from "electron";
import { writeAtomicJson } from "./report.mjs";
import { captureTemporalPassReplay } from "./temporal-pass-capture.mjs";
import { validateTemporalOutput } from "./temporal-text-evidence.mjs";

const config = JSON.parse(readFileSync(process.env.ASTER_TEMPORAL_GPU_CONFIG, "utf8"));
app.setPath("userData", join(config.output, "profile"));
for (const flag of [
  "force_high_performance_gpu",
  "disable-background-timer-throttling",
  "disable-renderer-backgrounding",
  "disable-backgrounding-occluded-windows",
])
  app.commandLine.appendSwitch(flag);
const report = { status: "failed", results: [], pass_replays: [] };
let window;
async function main() {
  try {
    await app.whenReady();
    window = new BrowserWindow({
      show: false,
      width: 320,
      height: 180,
      webPreferences: { backgroundThrottling: false, paintWhenInitiallyHidden: true },
    });
    await window.loadURL(config.url);
    const actual = await window.webContents.executeJavaScript("window.runTemporalTextGpuCheck()");
    const reference = JSON.parse(await readFile(join(config.reference, "manifest.json"), "utf8"));
    assert.deepEqual(
      actual.results.map((r) => r.mode),
      ["full", "enters", "exits", "transparent"],
    );
    assert.equal(actual.status, "passed");
    report.adapter = actual.adapter;
    const payloads = join(config.output, "payloads");
    await mkdir(payloads);
    const transcript = [];
    await window.loadURL(config.replayUrl);
    for (let index = 0; index < actual.results.length; index++) {
      const result = actual.results[index];
      const expected = reference.cases[index];
      assert.equal(expected.path, `${result.mode}.png`);
      const png = await readFile(join(config.reference, expected.path));
      const checked = validateTemporalOutput(result, expected, png);
      await writeFile(join(payloads, `${checked.pixel_hash}.bin`), Buffer.from(result.pixels));
      await writeFile(
        join(payloads, `${checked.pixel_hash}.replay.bin`),
        Buffer.from(result.replay),
      );
      await writeAtomicJson(join(payloads, `${checked.pixel_hash}.json`), result.messages);
      transcript.push(...result.messages);
      report.results.push(checked);
      const pass = await captureTemporalPassReplay(config, window, result, payloads);
      report.pass_replays.push(pass);
      for (const sample of result.sample_resources) transcript.push(...sample.messages);
    }
    await writeAtomicJson(join(config.output, "resources.input.json"), transcript);
    report.status = "passed";
  } catch (error) {
    report.error = error.stack ?? String(error);
  } finally {
    await writeAtomicJson(join(config.output, "gpu.json"), report);
    window?.destroy();
    app.exit(report.status === "passed" ? 0 : 1);
  }
}
void main();
