import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { app, BrowserWindow } from "electron";
import { runStep } from "./process.mjs";
import { writeAtomicJson } from "./report.mjs";

const config = JSON.parse(readFileSync(process.env.ASTER_LUT_GPU_CONFIG, "utf8"));
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
    const captured = await window.webContents.executeJavaScript("window.captureLutDraws()");
    report.adapter = captured.adapter;
    const payloads = join(config.output, "payloads");
    await mkdir(payloads);
    for (const r of captured.resources)
      await writeFile(join(payloads, `${r.message.hash}.bin`), Buffer.from(r.bytes));
    await writeAtomicJson(
      join(config.output, "input.json"),
      captured.resources.map((r) => r.message),
    );
    const cli = join(
      config.root,
      "target/release",
      process.platform === "win32" ? "aster-render-cli.exe" : "aster-render-cli",
    );
    const run = async (id, args) => {
      const result = await runStep(
        { id, file: cli, args },
        { root: config.root, output: config.output, env: process.env },
      );
      assert.equal(result.status, "passed");
    };
    await run("resources", [
      "ir",
      "resources",
      "--input",
      join(config.output, "input.json"),
      "--output",
      join(config.output, "decoded.json"),
      "--payloads",
      payloads,
    ]);
    const messages = JSON.parse(await readFile(join(config.output, "decoded.json"), "utf8"));
    assert.deepEqual(
      messages,
      captured.resources.map((r) => r.message),
    );
    const roundtrip = async (id, bytes) => {
      const input = join(config.output, `${id}.input.fpln`),
        output = join(config.output, `${id}.decoded.fpln`);
      await writeFile(input, Buffer.from(bytes));
      await run(id, ["ir", "roundtrip", "--input", input, "--output", output]);
      const decoded = await readFile(output);
      assert.deepEqual(decoded, Buffer.from(bytes));
      return Array.from(decoded);
    };
    const input = { sourceHash: captured.sourceHash, cases: [], resources: [] };
    for (const r of captured.cases) {
      input.cases.push({ id: r.id, plan: await roundtrip(r.id, r.plan) });
      await writeFile(join(config.output, `${r.id}.reference.bin`), Buffer.from(r.reference));
    }
    for (const message of messages)
      input.resources.push({
        message,
        bytes: Array.from(await readFile(join(payloads, `${message.hash}.bin`))),
      });
    await window.loadURL(`${config.url}?replay=1`);
    const replay = await window.webContents.executeJavaScript(
      `window.replayLutDraws(${JSON.stringify(input)})`,
    );
    assert.equal(replay.length, captured.cases.length);
    // Distinct results prove the fixture actually exercises each material control.
    assert.equal(
      new Set(captured.cases.map((r) => Buffer.from(r.reference).toString("base64"))).size,
      captured.cases.length,
    );
    for (let i = 0; i < replay.length; i++) {
      const original = captured.cases[i];
      assert.equal(replay[i].id, original.id);
      assert.equal(original.reference.length, 64 * 48 * 8);
      assert(
        original.reference.some((v) => v !== 0),
        "LUT fixture is empty",
      );
      assert.deepEqual(replay[i].pixels, original.reference);
      await writeFile(
        join(config.output, `${original.id}.replay.bin`),
        Buffer.from(replay[i].pixels),
      );
      report.results.push({
        id: original.id,
        exact: true,
        independent_device: true,
        bytes: original.reference.length,
        rust_roundtrip: true,
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
