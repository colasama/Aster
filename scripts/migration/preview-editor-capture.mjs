import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { finished } from "node:stream/promises";
import electron from "electron";
import { writeAtomicJson } from "./report.mjs";

const output = resolve(process.argv[2]);
await mkdir(output, { recursive: true });
const log = createWriteStream(join(output, "electron.log"), { flags: "wx" });
const report = { status: "failed", started_at: new Date().toISOString(), messages: [] };
const child = spawn(electron, ["scripts/migration/preview-editor-electron.mjs"], {
  cwd: process.cwd(),
  windowsHide: true,
  env: { ...process.env, ASTER_PREVIEW_EDITOR_OUTPUT: output },
  stdio: ["ignore", "pipe", "pipe", "ipc"],
});
report.pid = child.pid;
child.stdout.pipe(log, { end: false });
child.stderr.pipe(log, { end: false });
child.on("message", (message) => report.messages.push(message));
let force;
const timeout = setTimeout(
  () => {
    report.error = "Editor witness timed out";
    if (child.connected) child.disconnect();
    force = setTimeout(() => child.kill(), 5000);
  },
  process.env.ASTER_PREVIEW_BENCHMARK_SAMPLES ? 1800000 : 240000,
);
try {
  const code = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  report.exit_code = code;
  assert.equal(code, 0);
  const witness = JSON.parse(await readFile(join(output, "report.json"), "utf8"));
  assert.equal(witness.status, "passed", witness.error);
  assert(!report.error);
  report.status = "passed";
} catch (error) {
  report.error = String(error.stack ?? error);
  process.exitCode = 1;
} finally {
  clearTimeout(timeout);
  clearTimeout(force);
  log.end();
  await finished(log);
  report.finished_at = new Date().toISOString();
  await writeAtomicJson(join(output, "process.json"), report);
}
console.log(JSON.stringify({ status: report.status, error: report.error, output }));
