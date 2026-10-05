import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { app, BrowserWindow } from "electron";
import { runStep } from "./process.mjs";
import { writeAtomicJson } from "./report.mjs";

const config = JSON.parse(readFileSync(process.env.ASTER_PRECOMPOSITION_GPU_CONFIG, "utf8"));
app.setPath("userData", join(config.output, "profile"));
for (const flag of [
  "force_high_performance_gpu",
  "disable-background-timer-throttling",
  "disable-renderer-backgrounding",
  "disable-backgrounding-occluded-windows",
])
  app.commandLine.appendSwitch(flag);
const report = { status: "failed", results: [], roundtrips: [] };
let window;
async function main() {
  try {
    await app.whenReady();
    window = new BrowserWindow({
      show: false,
      webPreferences: { backgroundThrottling: false, paintWhenInitiallyHidden: true },
    });
    window.webContents.on("console-message", (event) => console.log(event.message));
    window.webContents.on("render-process-gone", (_event, details) =>
      console.log("Renderer exited", details),
    );
    await window.loadURL(config.url);
    const capture = await window.webContents.executeJavaScript("window.capturePrecompositions()");
    report.adapter = capture.adapter;
    const payloads = join(config.output, "payloads");
    await mkdir(payloads);
    const resources = new Map();
    for (const c of capture.cases)
      for (const packet of [c.bundle, c.warmup].filter(Boolean))
        for (const r of packet.resources) {
          if (resources.has(r.message.hash)) assert.deepEqual(resources.get(r.message.hash), r);
          resources.set(r.message.hash, r);
        }
    for (const r of resources.values())
      await writeFile(join(payloads, `${r.message.hash}.bin`), Buffer.from(r.bytes));
    const messages = [...resources.values()].map((r) => r.message);
    await writeAtomicJson(join(config.output, "input.json"), messages);
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
    const decodedMessages = JSON.parse(await readFile(join(config.output, "decoded.json"), "utf8"));
    assert.deepEqual(decodedMessages, messages);
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
    for (const r of resources.values())
      if (r.message.kind === "buffer" && Buffer.from(r.bytes).subarray(0, 4).toString() === "FPLN")
        r.bytes = await roundtrip(r.message.hash, r.bytes);
    const input = [];
    for (const c of capture.cases) {
      const item = { id: c.id, output: c.output };
      for (const name of ["bundle", "warmup"])
        if (c[name]) {
          const packet = c[name];
          item[name] = {
            plan: await roundtrip(`${c.id}-${name}`, packet.plan),
            resources: packet.resources.map((r) => ({
              message: decodedMessages.find((m) => m.hash === r.message.hash),
              bytes: resources.get(r.message.hash).bytes,
            })),
          };
        }
      input.push(item);
      await writeFile(join(config.output, `${c.id}.reference.bin`), Buffer.from(c.reference));
    }
    await writeAtomicJson(join(config.output, "replay-input.json"), input);
    await window.loadURL(`${config.url}?replay=1`);
    const replay = await window.webContents.executeJavaScript(
      `window.replayPrecompositions(${JSON.stringify(input)})`,
    );
    for (const c of capture.cases) {
      const result = replay.find((r) => r.id === c.id);
      assert(result);
      const expected = Buffer.from(c.reference),
        actual = Buffer.from(result.outputs[0].pixels);
      await writeFile(join(config.output, `${c.id}.replay.bin`), actual);
      assert.equal(expected.length, 24576);
      assert(expected.some((v) => v !== 0));
      assert.deepEqual(actual, expected, `${c.id}: supplied replay differs`);
      const mutations = [];
      for (const o of result.outputs.slice(1)) {
        const altered = Buffer.from(o.pixels),
          file = `${c.id}.${o.mutation}.bin`;
        await writeFile(join(config.output, file), altered);
        let changed = 0;
        for (let i = 0; i < expected.length; i += 8)
          if (!expected.subarray(i, i + 8).equals(altered.subarray(i, i + 8))) changed++;
        assert(changed > 16, `${c.id}/${o.mutation}: perturbation is not visible`);
        mutations.push({ id: o.mutation, file, changed_pixels: changed });
      }
      report.results.push({
        id: c.id,
        exact: true,
        independent_device: true,
        rust_roundtrip: true,
        bytes: actual.length,
        scenes: c.scenes,
        generators: c.generators,
        pinned: result.outputs[0].pinned,
        mutations,
      });
    }
    report.rust_plans = report.roundtrips.length;
    report.rust_messages = messages.length;
    report.status = "passed";
  } catch (error) {
    report.error = error.stack ?? error.message;
  } finally {
    await writeAtomicJson(join(config.output, "gpu.json"), report);
    window?.destroy();
    app.exit(report.status === "passed" ? 0 : 1);
  }
}
void main();
