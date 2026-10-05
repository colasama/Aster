import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { app, BrowserWindow } from "electron";
import { runStep } from "./process.mjs";
import { writeAtomicJson } from "./report.mjs";

const config = JSON.parse(readFileSync(process.env.ASTER_AUXILIARY_GPU_CONFIG, "utf8"));
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
    const captured = await window.webContents.executeJavaScript("window.captureAuxiliary()");
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
    const resources = new Map(
        captured.cases.flatMap((c) => c.resources.map((r) => [r.message.hash, r])),
      ),
      payloads = join(config.output, "payloads");
    await mkdir(payloads);
    for (const [hash, r] of resources)
      await writeFile(join(payloads, `${hash}.bin`), Buffer.from(r.pixels));
    await writeAtomicJson(
      join(config.output, "input.json"),
      [...resources.values()].map((r) => r.message),
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
      [...resources.values()].map((r) => r.message),
    );
    const cases = [];
    for (const c of captured.cases) {
      const item = {
        id: c.id,
        tier: c.tier,
        scene: await roundtrip(`${c.id}-scene`, c.scene),
        auxiliary: await roundtrip(`${c.id}-auxiliary`, c.auxiliary),
        resources: [],
      };
      if (c.prime) item.prime = await roundtrip(`${c.id}-prime`, c.prime);
      for (const r of c.resources)
        item.resources.push({
          texture: r.texture,
          message: messages.find((m) => m.hash === r.message.hash),
          pixels: Array.from(await readFile(join(payloads, `${r.message.hash}.bin`))),
        });
      cases.push(item);
    }
    await writeAtomicJson(join(config.output, "replay-input.json"), cases);
    await window.loadURL(`${config.url}?replay=1`);
    const replay = await window.webContents.executeJavaScript(
      `window.replayAuxiliary(${JSON.stringify(cases)})`,
    );
    assert.equal(replay.length, captured.cases.length);
    for (const [i, original] of captured.cases.entries()) {
      const actual = replay[i];
      assert.equal(actual.id, original.id);
      assert.deepEqual(actual.targets, original.reference);
      const bytes = Buffer.concat(original.reference.map((t) => Buffer.from(t.bytes)));
      if (original.id === "cleared") assert(bytes.every((v) => v === 0));
      else assert(bytes.some((v) => v !== 0));
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
        tier: original.tier,
        exact: true,
        independent_device: true,
        rust_roundtrip: true,
        bytes: bytes.length,
        targets: original.reference.map((t) => ({
          name: t.name,
          bpp: t.bpp,
          bytes: t.bytes.length,
        })),
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
    window?.destroy();
    app.exit(report.status === "passed" ? 0 : 1);
  }
}
void main();
