import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { app, BrowserWindow } from "electron";
import { writeAtomicJson } from "./report.mjs";

const config = JSON.parse(readFileSync(process.env.ASTER_ENCODED_GPU_CONFIG, "utf8"));
app.setPath("userData", join(config.output, "profile"));
app.commandLine.appendSwitch("force_high_performance_gpu");
app.commandLine.appendSwitch("disable-renderer-backgrounding");
let window;
const report = { status: "failed", fixtures: [] };
async function main() {
  try {
    const inputs = JSON.parse(await readFile(config.inputs, "utf8"));
    const payloads = await Promise.all(
      inputs.map(async (input) => ({
        id: input.id,
        bytes: Array.from(await readFile(join(config.root, input.path))),
      })),
    );
    await app.whenReady();
    window = new BrowserWindow({
      show: false,
      webPreferences: { backgroundThrottling: false, paintWhenInitiallyHidden: true },
    });
    await window.loadURL(config.url);
    const expression = `window.captureProvidedNormalTextures(${JSON.stringify(payloads)})`;
    const captured = await window.webContents.executeJavaScript(expression);
    await window.loadURL(`${config.url}?replay=1`);
    const replay = await window.webContents.executeJavaScript(expression);
    assert.deepEqual(replay, captured, "Independent browser devices must agree");
    for (const [index, result] of captured.entries()) {
      const { type, ...message } = result.message;
      assert.equal(type, "put_resource");
      assert.equal(result.id, inputs[index].id);
      assert.equal(result.width, inputs[index].width);
      assert.equal(result.height, inputs[index].height);
      const encoded = Buffer.from(payloads[index].bytes);
      assert.equal(createHash("sha256").update(encoded).digest("hex"), inputs[index].sha256);
      report.fixtures.push({
        id: result.id,
        message,
        encoded: encoded.toString("base64"),
        rgba: result.reference,
        rgba_sha256: createHash("sha256").update(Buffer.from(result.reference)).digest("hex"),
        width: result.width,
        height: result.height,
        independent_devices_exact: true,
      });
    }
    report.gpu_info = await app.getGPUInfo("complete");
    report.status = "passed";
  } catch (error) {
    report.error = error.stack ?? String(error);
  } finally {
    await writeAtomicJson(join(config.output, "provided.json"), report);
    window?.destroy();
    app.exit(report.status === "passed" ? 0 : 1);
  }
}
void main();
