import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { appCommands, runAppChecks } from "./app-checks.mjs";
import { writeAtomicJson } from "./report.mjs";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "aster-app-gate-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const output = join(root, "evidence");
  const source = join(root, "build", "ffmpeg");
  await mkdir(source, { recursive: true });
  for (const name of ["ffmpeg.exe", "ffprobe.exe"]) await writeFile(join(source, name), name);
  const execute = async (command) => {
    if (command.id === "app-package") {
      const bin = join(output, "package", "win-unpacked", "resources", "bin");
      await mkdir(bin, { recursive: true });
      for (const name of ["ffmpeg.exe", "ffprobe.exe"])
        await copyFile(join(source, name), join(bin, name));
      for (const name of ["aster-desktop-bridge.exe", "aster-mcp.exe"])
        await writeFile(join(bin, name), name);
    }
    if (command.env) {
      await writeAtomicJson(join(command.env.ASTER_SMOKE_OUTPUT, "report.json"), {
        status: "passed",
        background: command.id === "app-background",
        binary: command.args[1],
        preview: [{ width: 320, height: 180 }],
        render_job: { id: "test-job", status: "completed", output: "test.mp4" },
      });
    }
    return { id: command.id, status: "passed" };
  };
  return { context: { root, output }, execute };
}

test("G6 rebuilds and packages current sources without preparing or replacing FFmpeg", () => {
  const commands = appCommands("evidence");
  assert.deepEqual(commands[0].args, ["build"]);
  assert.deepEqual(commands[1].args, [
    "build",
    "--release",
    "-p",
    "aster-desktop-bridge",
    "--bin",
    "aster-mcp",
  ]);
  assert(commands[2].args.includes("--dir"));
  assert.deepEqual(commands[2].args.slice(-3, -1), ["--publish", "never"]);
  assert(commands[4].args.includes("--background"));
  assert(!JSON.stringify(commands).includes("prepare-ffmpeg"));
});

test("full G6 requires fresh package and both preview and queue evidence", async (t) => {
  const { context, execute } = await fixture(t);
  const gate = await runAppChecks(context, execute, "win32");
  assert.equal(gate.status, "passed");
  assert.equal(gate.steps.length, 5);
  assert.equal(gate.evidence.ffmpeg_preserved, true);
  assert.equal(gate.evidence.foreground.render_job.status, "completed");
  assert.equal(gate.evidence.background.render_job.status, "completed");
});

test("build failure prevents packaging and stale smoke reuse", async (t) => {
  const { context } = await fixture(t);
  const calls = [];
  const gate = await runAppChecks(
    context,
    async (command) => {
      calls.push(command.id);
      return { id: command.id, status: "failed" };
    },
    "win32",
  );
  assert.equal(gate.status, "failed");
  assert.deepEqual(calls, ["app-build"]);
});

test("changed packaged FFmpeg is rejected before any smoke execution", async (t) => {
  const { context, execute } = await fixture(t);
  const gate = await runAppChecks(
    context,
    async (command) => {
      const step = await execute(command);
      if (command.id === "app-package") {
        await writeFile(
          join(context.output, "package", "win-unpacked", "resources", "bin", "ffmpeg.exe"),
          "changed",
        );
      }
      return step;
    },
    "win32",
  );
  assert.equal(gate.status, "failed");
  assert.match(gate.error, /does not match/);
  assert.equal(gate.steps.length, 3);
});

test("a passing smoke exit code without its matching evidence fails G6", async (t) => {
  const { context, execute } = await fixture(t);
  const gate = await runAppChecks(
    context,
    async (command) => {
      if (command.id === "app-background") return { id: command.id, status: "passed" };
      return execute(command);
    },
    "win32",
  );
  assert.equal(gate.status, "failed");
  assert.match(gate.error, /ENOENT/);
});
