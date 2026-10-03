import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { performance } from "node:perf_hooks";
import { finished } from "node:stream/promises";

export async function runStep(command, context, dependencies = {}) {
  await mkdir(context.output, { recursive: true });
  const log = join(context.output, `${command.id}.log`);
  const stream = (dependencies.createLogStream ?? createWriteStream)(log, { flags: "wx" });
  const started = performance.now();
  const result = {
    id: command.id,
    command: [command.file, ...command.args],
    started_at: new Date().toISOString(),
    log: relative(context.root, log).replaceAll("\\", "/"),
    status: "failed",
    exit_code: null,
    signal: null,
  };
  let child;
  const streamDone = finished(stream).catch((error) => {
    result.error = `Log write failed: ${error.message}`;
    child?.kill();
  });
  let file = command.file;
  let args = command.args;
  if (file === "node") file = process.execPath;
  if (file === "pnpm" && /\.[cm]?js$/.test(context.env.npm_execpath ?? "")) {
    file = process.execPath;
    args = [context.env.npm_execpath, ...args];
  }
  stream.write(`Command: ${JSON.stringify(result.command)}\n`);
  await new Promise((resolve) => {
    child = spawn(file, args, {
      cwd: context.root,
      env: { ...context.env, ...command.env },
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let timeout;
    let killDeadline;
    child.stdout.on("data", (chunk) => stream.write(chunk));
    child.stderr.on("data", (chunk) => stream.write(chunk));
    child.on("error", (error) => {
      result.error = error.message;
      stream.write(`${error.stack ?? error.message}\n`);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timeout);
      clearTimeout(killDeadline);
      result.exit_code = code;
      result.signal = signal;
      result.status = code === 0 && !result.error ? "passed" : "failed";
      resolve();
    });
    timeout = setTimeout(() => {
      result.error = `Command exceeded ${command.timeout_ms ?? 1_800_000} ms`;
      if (process.platform === "win32") {
        const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
          windowsHide: true,
          stdio: "ignore",
        });
        killer.on("error", () => child.kill());
        killer.on("close", (code) => {
          if (code !== 0) child.kill();
        });
      } else child.kill("SIGKILL");
      killDeadline = setTimeout(() => {
        result.error += "; process termination did not complete within 5 seconds";
        child.kill("SIGKILL");
        resolve();
      }, 5_000);
      killDeadline.unref();
    }, command.timeout_ms ?? 1_800_000);
    timeout.unref();
  });
  stream.end();
  await streamDone;
  if (result.error) result.status = "failed";
  result.finished_at = new Date().toISOString();
  result.duration_ms = Math.round(performance.now() - started);
  context.print?.(`${result.id}: ${result.status} (${result.duration_ms} ms)`);
  return result;
}
