import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { app, BrowserWindow } from "electron";
import { DesktopBridgeClient } from "../parity/desktop-bridge.mjs";
import { runStep } from "./process.mjs";
import { writeAtomicJson } from "./report.mjs";

const config = JSON.parse(readFileSync(process.env.ASTER_AUXILIARY_GENERATORS_CONFIG, "utf8"));
app.setPath("userData", join(config.output, "profile"));
for (const flag of [
  "force_high_performance_gpu",
  "disable-background-timer-throttling",
  "disable-renderer-backgrounding",
  "disable-backgrounding-occluded-windows",
])
  app.commandLine.appendSwitch(flag);
let window, bridge;
const report = { status: "failed", results: [], roundtrips: [] };
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
      `window.captureAuxiliaryGenerators(${JSON.stringify(status)})`,
    );
    report.adapter = captured.adapter;
    const cli = join(config.root, `target/release/aster-render-cli${extension}`);
    const run = async (id, args) => {
      const result = await runStep(
        { id, file: cli, args },
        { root: config.root, output: config.output, env: process.env },
      );
      assert.equal(result.status, "passed", result.log);
    };
    const roundtrip = async (id, bytes) => {
      const input = join(config.output, `${id}.input.fpln`),
        output = join(config.output, `${id}.decoded.fpln`);
      await writeFile(input, Buffer.from(bytes));
      await run(id, ["ir", "roundtrip", "--input", input, "--output", output]);
      const decoded = await readFile(output);
      assert.deepEqual(decoded, Buffer.from(bytes));
      report.roundtrips.push(id);
      return Array.from(decoded);
    };
    const payloads = join(config.output, "payloads");
    await mkdir(payloads);
    for (const r of captured.resources)
      await writeFile(join(payloads, `${r.message.hash}.bin`), Buffer.from(r.bytes));
    await writeAtomicJson(
      join(config.output, "input.json"),
      captured.resources.map((r) => r.message),
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
    for (const c of captured.cases) {
      const item = {
        id: c.id,
        plans: [],
        auxiliary: await roundtrip(`${c.id}-auxiliary`, c.auxiliary),
      };
      for (const [i, p] of c.plans.entries())
        item.plans.push(await roundtrip(`${c.id}-generator-${i}`, p));
      input.cases.push(item);
    }
    for (const message of messages)
      input.resources.push({
        message,
        bytes: Array.from(await readFile(join(payloads, `${message.hash}.bin`))),
      });
    await writeAtomicJson(join(config.output, "replay-input.json"), input);
    await window.loadURL(`${config.url}?replay=1`);
    const replay = await window.webContents.executeJavaScript(
      `window.replayAuxiliaryGenerators(${JSON.stringify(input)})`,
    );
    assert.equal(replay.length, captured.cases.length);
    for (const [i, original] of captured.cases.entries()) {
      const actual = replay[i];
      assert.equal(actual.id, original.id);
      assert.deepEqual(actual.targets, original.reference);
      assert.deepEqual(actual.counts, original.counts);
      const bytes = Buffer.concat(original.reference.map((t) => Buffer.from(t.bytes)));
      if (original.id === "audio-bars") {
        assert.equal(original.auxiliary_count, 0);
        assert(bytes.every((v) => v === 0));
        assert.equal(actual.missing_auxiliary_rejected, true);
      } else {
        assert(bytes.some((v) => v !== 0));
        assert.equal(original.auxiliary_count, original.counts.length);
      }
      await writeFile(join(config.output, `${original.id}.reference.bin`), bytes);
      await writeFile(
        join(config.output, `${original.id}.replay.bin`),
        Buffer.concat(actual.targets.map((t) => Buffer.from(t.bytes))),
      );
      const mutations = [];
      for (const m of actual.mutations) {
        let changed = 0;
        for (const [index, t] of m.targets.entries()) {
          assert.equal(t.name, original.reference[index].name);
          assert.equal(t.bytes.length, original.reference[index].bytes.length);
          for (let j = 0; j < t.bytes.length; j += t.bpp)
            if (
              t.bytes
                .slice(j, j + t.bpp)
                .some((v, k) => v !== original.reference[index].bytes[j + k])
            )
              changed++;
        }
        assert(changed > 16, `${original.id}/${m.id} must affect visible surface pixels`);
        const file = `${original.id}.${m.id}.bin`;
        await writeFile(
          join(config.output, file),
          Buffer.concat(m.targets.map((t) => Buffer.from(t.bytes))),
        );
        mutations.push({ id: m.id, file, changed_pixels: changed });
      }
      report.results.push({
        id: original.id,
        exact: true,
        independent_device: true,
        rust_roundtrip: true,
        bytes: bytes.length,
        targets: original.reference.map((t) => ({
          name: t.name,
          bpp: t.bpp,
          bytes: t.bytes.length,
        })),
        counts: original.counts,
        auxiliary_count: original.auxiliary_count,
        missing_auxiliary_rejected: actual.missing_auxiliary_rejected,
        mutations,
      });
    }
    report.rust_plans = report.roundtrips.length;
    report.rust_messages = messages.length;
    report.status = "passed";
  } catch (error) {
    report.error = error.stack ?? String(error);
  } finally {
    await writeAtomicJson(join(config.output, "gpu.json"), report);
    bridge?.dispose();
    window?.destroy();
    app.exit(report.status === "passed" ? 0 : 1);
  }
}
void main();
