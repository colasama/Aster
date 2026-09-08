import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** A private, GPU-capable editor whose lifetime belongs to one MCP connection. */
export async function startBackgroundEditor(executable: string, launchArgs: string[]) {
  const profile = await mkdtemp(join(tmpdir(), "aster-mcp-"));
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    ASTER_AUTOMATION_ENABLED: "1",
    ASTER_AUTOMATION_PORT: "0",
  };
  delete environment.ELECTRON_RUN_AS_NODE;
  const child = spawn(
    executable,
    [...launchArgs, "--automation-background", `--user-data-dir=${profile}`],
    {
      env: environment,
      windowsHide: true,
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    },
  );
  child.stderr?.on("data", (data: Buffer) => process.stderr.write(data));
  let closing: Promise<void> | undefined;
  const close = () => {
    closing ??= (async () => {
      if (child.pid && child.exitCode === null && child.signalCode === null) {
        const exited = once(child, "exit");
        if (child.connected) child.disconnect();
        const timer = setTimeout(() => child.kill(), 10_000);
        try {
          await exited;
        } finally {
          clearTimeout(timer);
        }
      }
      await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    })();
    return closing;
  };
  try {
    const port = await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(
        () => finish(new Error("Background Aster did not start within 60 seconds")),
        60_000,
      );
      const failed = (error: Error) => finish(error);
      const exited = (code: number | null) =>
        finish(new Error(`Background Aster exited during startup (${code})`));
      const ready = (value: unknown) => {
        if (!value || typeof value !== "object" || !("port" in value)) return;
        const port = Number(value.port);
        if (!Number.isInteger(port) || port < 1 || port > 65535) return;
        finish(undefined, port);
      };
      function finish(error?: Error, port?: number) {
        clearTimeout(timer);
        child.off("error", failed);
        child.off("exit", exited);
        child.off("message", ready);
        if (error) reject(error);
        else resolve(port as number);
      }
      child.once("error", failed);
      child.once("exit", exited);
      child.on("message", ready);
    });
    return { port, close };
  } catch (error) {
    await close();
    throw error;
  }
}
