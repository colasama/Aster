import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { app, BrowserWindow } from "electron";
import { runStep } from "./process.mjs";
import { writeAtomicJson } from "./report.mjs";

const config = JSON.parse(readFileSync(process.env.ASTER_ENCODED_GPU_CONFIG, "utf8"));
app.setPath("userData", join(config.output, "profile"));
for (const flag of [
  "force_high_performance_gpu",
  "disable-background-timer-throttling",
  "disable-renderer-backgrounding",
  "disable-backgrounding-occluded-windows",
])
  app.commandLine.appendSwitch(flag);
let window;
const report = { status: "failed", results: [] };
async function main() {
  try {
    await app.whenReady();
    window = new BrowserWindow({
      show: false,
      webPreferences: { backgroundThrottling: false, paintWhenInitiallyHidden: true },
    });
    await window.loadURL(config.url);
    const captured = await window.webContents.executeJavaScript("window.captureNormalTextures()");
    assert.deepEqual(
      captured.results.map((r) => r.encoding),
      ["png", "jpeg", "webp"],
    );
    report.adapter = captured.adapter;
    const messages = captured.results.map((r) => r.message);
    const payloads = join(config.output, "payloads");
    await mkdir(payloads);
    for (const r of captured.results) {
      await writeFile(join(payloads, `${r.message.hash}.bin`), Buffer.from(r.bytes));
      await writeFile(join(config.output, `${r.encoding}.reference.bin`), Buffer.from(r.reference));
    }
    await writeAtomicJson(join(config.output, "input.json"), messages);
    const rust = await runStep(
      {
        id: "rust-resources",
        file: join(
          config.root,
          "target/release",
          process.platform === "win32" ? "aster-render-cli.exe" : "aster-render-cli",
        ),
        args: [
          "ir",
          "resources",
          "--input",
          join(config.output, "input.json"),
          "--output",
          join(config.output, "decoded.json"),
          "--payloads",
          payloads,
        ],
      },
      { root: config.root, output: config.output, env: process.env },
    );
    assert.equal(rust.status, "passed");
    const decoded = JSON.parse(await readFile(join(config.output, "decoded.json"), "utf8"));
    assert.deepEqual(decoded, messages);
    const inputs = [];
    for (const message of decoded)
      inputs.push({
        message,
        bytes: Array.from(await readFile(join(payloads, `${message.hash}.bin`))),
      });
    await window.loadURL(`${config.url}?replay=1`);
    const replay = await window.webContents.executeJavaScript(
      `window.replayNormalTextures(${JSON.stringify(inputs)})`,
    );
    assert.equal(replay.length, 3);
    for (let index = 0; index < captured.results.length; index++) {
      const r = captured.results[index];
      assert.equal(r.reference.length, 24);
      assert.deepEqual(replay[index], r.reference);
      await writeFile(join(config.output, `${r.encoding}.replay.bin`), Buffer.from(replay[index]));
      report.results.push({
        encoding: r.encoding,
        hash: r.message.hash,
        exact: true,
        independent_device: true,
        bytes: r.bytes.length,
      });
    }
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
