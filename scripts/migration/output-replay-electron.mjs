import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { app, BrowserWindow } from "electron";
import { runStep } from "./process.mjs";
import { writeAtomicJson } from "./report.mjs";

const config = JSON.parse(readFileSync(process.env.ASTER_OUTPUT_GPU_CONFIG, "utf8"));
app.setPath("userData", join(config.output, "profile"));
for (const flag of [
  "force_high_performance_gpu",
  "disable-background-timer-throttling",
  "disable-renderer-backgrounding",
  "disable-backgrounding-occluded-windows",
])
  app.commandLine.appendSwitch(flag);
let window;
const report = { status: "failed", results: [], roundtrips: [] };
async function main() {
  try {
    await app.whenReady();
    window = new BrowserWindow({
      show: false,
      webPreferences: { backgroundThrottling: false, paintWhenInitiallyHidden: true },
    });
    await window.loadURL(config.url);
    const captured = await window.webContents.executeJavaScript("window.captureOutput()");
    report.adapter = captured.adapter;
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

    const cases = [];
    for (const c of captured.cases) {
      const plans = {};
      for (const [name, bytes] of Object.entries(c.plans))
        plans[name] = await roundtrip(`${c.id}-${name}`, bytes);
      cases.push({ id: c.id, plans, attachments: c.attachments, uniforms: c.uniforms });
    }
    await writeAtomicJson(join(config.output, "replay-input.json"), cases);
    await window.loadURL(`${config.url}?replay=1`);
    const replay = await window.webContents.executeJavaScript(
      `window.replayOutput(${JSON.stringify(cases)})`,
    );
    assert.equal(replay.length, cases.length);
    for (const [i, c] of captured.cases.entries()) {
      const actual = replay[i];
      assert.equal(actual.id, c.id);
      assert.deepEqual(actual.bytes, c.reference, `${c.id} exact replay`);
      const bytes = Buffer.from(c.reference);
      assert(bytes.some((v) => v !== 0));
      await writeFile(join(config.output, `${c.id}.reference.bin`), bytes);
      await writeFile(join(config.output, `${c.id}.replay.bin`), Buffer.from(actual.bytes));
      const mutations = [];
      for (const m of actual.mutations) {
        assert.equal(m.bytes.length, bytes.length);
        let changed = 0;
        for (let p = 0; p < bytes.length; p += 4)
          if (m.bytes.slice(p, p + 4).some((v, k) => v !== bytes[p + k])) changed++;
        assert(changed > 16, `${c.id}/${m.id} must change visible pixels: ${changed}`);
        const file = `${c.id}.${m.id}.bin`;
        await writeFile(join(config.output, file), Buffer.from(m.bytes));
        mutations.push({ id: m.id, file, changed_pixels: changed });
      }
      report.results.push({
        id: c.id,
        exact: true,
        independent_device: true,
        rust_roundtrip: true,
        bytes: bytes.length,
        mutations,
      });
    }
    report.rust_plans = report.roundtrips.length;
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
