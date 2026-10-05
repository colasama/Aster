import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { app, BrowserWindow } from "electron";
import { DesktopBridgeClient } from "../parity/desktop-bridge.mjs";
import { runStep } from "./process.mjs";
import { writeAtomicJson } from "./report.mjs";

const config = JSON.parse(readFileSync(process.env.ASTER_GENERATOR_GPU_CONFIG, "utf8"));
app.setPath("userData", join(config.output, "profile"));
for (const flag of [
  "force_high_performance_gpu",
  "disable-background-timer-throttling",
  "disable-renderer-backgrounding",
  "disable-backgrounding-occluded-windows",
])
  app.commandLine.appendSwitch(flag);
let window, bridge;
const report = { status: "failed", results: [] };
async function main() {
  try {
    await app.whenReady();
    const extension = process.platform === "win32" ? ".exe" : "";
    bridge = new DesktopBridgeClient(
      join(config.root, `target/release/aster-desktop-bridge${extension}`),
      join(config.output, "bridge-profile"),
    );
    await bridge.invoke("install_plugin", {
      source: join(config.root, "examples/plugins/audio-spectrum"),
    });
    const status = await bridge.invoke("load_plugin_runtime", {
      pluginIds: ["org.aster.example.audio-spectrum"],
    });
    assert.equal(status.report.failures.length, 0);
    await writeAtomicJson(join(config.output, "plugin-status.json"), status);
    window = new BrowserWindow({
      show: false,
      webPreferences: { backgroundThrottling: false, paintWhenInitiallyHidden: true },
    });
    await window.loadURL(config.url);
    const captured = await window.webContents.executeJavaScript(
      `window.captureGenerators(${JSON.stringify(status)})`,
    );
    report.adapter = captured.adapter;
    for (const c of captured.cases)
      await writeFile(join(config.output, `${c.id}.reference.bin`), Buffer.from(c.reference));
    if (config.referenceOnly) {
      report.status = "captured";
      report.results = captured.cases.map((c) => ({
        id: c.id,
        counts: c.counts,
        root_time: c.rootTime,
        bytes: c.reference.length,
      }));
      return;
    }
    const payloads = join(config.output, "payloads");
    await mkdir(payloads);
    for (const r of captured.resources)
      await writeFile(join(payloads, `${r.message.hash}.bin`), Buffer.from(r.bytes));
    await writeAtomicJson(
      join(config.output, "input.json"),
      captured.resources.map((r) => r.message),
    );
    const cli = join(config.root, `target/release/aster-render-cli${extension}`);
    const run = async (id, args) =>
      assert.equal(
        (
          await runStep(
            { id, file: cli, args },
            { root: config.root, output: config.output, env: process.env },
          )
        ).status,
        "passed",
      );
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
    const input = { cases: [], resources: [] };
    report.rust_plans = 0;
    for (const c of captured.cases) {
      const plans = [];
      for (let i = 0; i < c.plans.length; i++) {
        const source = join(config.output, `${c.id}-${i}.input.fpln`),
          out = join(config.output, `${c.id}-${i}.decoded.fpln`);
        await writeFile(source, Buffer.from(c.plans[i]));
        await run(`${c.id}-${i}`, ["ir", "roundtrip", "--input", source, "--output", out]);
        const decoded = await readFile(out);
        assert.deepEqual(decoded, Buffer.from(c.plans[i]));
        plans.push(Array.from(decoded));
        report.rust_plans++;
      }
      input.cases.push({ id: c.id, plans });
    }
    for (const message of messages)
      input.resources.push({
        message,
        bytes: Array.from(await readFile(join(payloads, `${message.hash}.bin`))),
      });
    await window.loadURL(`${config.url}?replay=1`);
    const replay = await window.webContents.executeJavaScript(
      `window.replayGenerators(${JSON.stringify(input)})`,
    );
    assert.equal(replay.length, captured.cases.length);
    assert.equal(
      new Set(captured.cases.map((c) => Buffer.from(c.reference).toString("base64"))).size,
      captured.cases.length,
    );
    for (let i = 0; i < replay.length; i++) {
      const original = captured.cases[i],
        current = replay[i];
      assert.equal(current.id, original.id);
      assert.equal(original.reference.length, 98304);
      assert(
        original.reference.some((v) => v !== 0),
        `${original.id} is empty`,
      );
      await writeFile(
        join(config.output, `${original.id}.replay.bin`),
        Buffer.from(current.pixels),
      );
      assert.deepEqual(
        current.pixels,
        original.reference,
        `${original.id} differs from retained generator execution`,
      );
      assert.deepEqual(current.counts, original.counts);
      const mutations = [];
      for (const m of current.mutations) {
        assert.equal(m.pixels.length, original.reference.length);
        let changed = 0;
        for (let j = 0; j < m.pixels.length; j += 8)
          if (m.pixels.slice(j, j + 8).some((v, k) => v !== original.reference[j + k])) changed++;
        const file = `${original.id}.${m.id}.bin`;
        await writeFile(join(config.output, file), Buffer.from(m.pixels));
        assert(changed > 16, `${original.id}/${m.id} must visibly change GPU pixels`);
        mutations.push({ id: m.id, file, changed_pixels: changed });
      }
      report.results.push({
        id: original.id,
        exact: true,
        independent_device: true,
        rust_roundtrip: true,
        bytes: original.reference.length,
        counts: current.counts,
        mutations,
      });
    }
    report.rust_messages = messages.length;
    report.status = "passed";
  } catch (error) {
    report.error = error.stack ?? String(error);
  } finally {
    await writeAtomicJson(join(config.output, "gpu.json"), report);
    bridge?.dispose();
    window?.destroy();
    app.exit(["passed", "captured"].includes(report.status) ? 0 : 1);
  }
}
void main();
