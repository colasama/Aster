import { spawn } from "node:child_process";
import { mkdir, readFile, rename, rm, rmdir, stat, writeFile } from "node:fs/promises";
import { dirname, parse, resolve } from "node:path";

const MAX_FILE_BYTES = 1024 * 1024;
const MAX_READ_BYTES = 64 * 1024;
const MAX_OUTPUT_BYTES = 64 * 1024;
const MAX_PROCESS_ARGS = 64;
const MAX_TIMEOUT_MS = 60_000;

export const FULL_ACCESS_TOOL_NAMES = new Set([
  "read_file",
  "write_file",
  "delete_path",
  "run_process",
  "network_request",
  "get_plugin_status",
  "install_plugin",
  "set_plugin_enabled",
  "set_plugin_safe_mode",
  "set_plugin_hot_reload",
  "pack_project",
  "unpack_project",
  "link_project_asset",
]);

const APPLICATION_TOOL_NAMES = new Set([
  "get_plugin_status",
  "install_plugin",
  "set_plugin_enabled",
  "set_plugin_safe_mode",
  "set_plugin_hot_reload",
  "pack_project",
  "unpack_project",
  "link_project_asset",
]);

export type FullAccessApplicationToolHandler = (
  toolName: string,
  input: Record<string, unknown>,
  signal: AbortSignal,
) => Promise<unknown>;

interface ActiveCall {
  ownerId: number;
  sessionId: string;
  controller: AbortController;
}

export interface FullAccessAuditEvent {
  toolName: string;
  ownerId: number;
  sessionId: string;
  target: string;
  irreversible: boolean;
  status: "ok" | "error" | "cancelled";
  startedAt: string;
  finishedAt: string;
}

export class FullAccessToolService {
  readonly #calls = new Map<string, ActiveCall>();
  readonly #audit: FullAccessAuditEvent[] = [];

  constructor(readonly applicationToolHandler?: FullAccessApplicationToolHandler) {}

  async execute(
    ownerId: number,
    sessionId: string,
    toolName: string,
    input: Record<string, unknown>,
  ): Promise<unknown> {
    if (!FULL_ACCESS_TOOL_NAMES.has(toolName))
      throw new Error(`Full Access tool is not registered: ${toolName}`);
    const callId = crypto.randomUUID();
    const controller = new AbortController();
    const call = { ownerId, sessionId, controller };
    this.#calls.set(callId, call);
    const startedAt = new Date().toISOString();
    const target = describeFullAccessTarget(toolName, input);
    const irreversible = !["read_file", "network_request", "get_plugin_status"].includes(toolName);
    try {
      const result = await this.#dispatch(toolName, input, controller.signal);
      this.#record({
        toolName,
        ownerId,
        sessionId,
        target,
        irreversible,
        status: "ok",
        startedAt,
        finishedAt: new Date().toISOString(),
      });
      return result;
    } catch (error) {
      this.#record({
        toolName,
        ownerId,
        sessionId,
        target,
        irreversible,
        status: controller.signal.aborted ? "cancelled" : "error",
        startedAt,
        finishedAt: new Date().toISOString(),
      });
      throw error;
    } finally {
      this.#calls.delete(callId);
    }
  }

  abortSession(sessionId: string): void {
    for (const call of this.#calls.values())
      if (call.sessionId === sessionId) call.controller.abort();
  }

  abortOwner(ownerId: number): void {
    for (const call of this.#calls.values()) if (call.ownerId === ownerId) call.controller.abort();
  }

  auditEvents(): FullAccessAuditEvent[] {
    return structuredClone(this.#audit);
  }

  #dispatch(toolName: string, input: Record<string, unknown>, signal: AbortSignal) {
    if (APPLICATION_TOOL_NAMES.has(toolName)) {
      if (!this.applicationToolHandler)
        throw new Error("Full Access Aster application tools are unavailable");
      return this.applicationToolHandler(toolName, input, signal);
    }
    switch (toolName) {
      case "read_file":
        return readBoundedFile(input, signal);
      case "write_file":
        return writeBoundedFile(input, signal);
      case "delete_path":
        return deleteExactPath(input, signal);
      case "run_process":
        return runBoundedProcess(input, signal);
      case "network_request":
        return boundedNetworkRequest(input, signal);
      default:
        throw new Error(`Full Access tool is not implemented: ${toolName}`);
    }
  }

  #record(event: FullAccessAuditEvent): void {
    this.#audit.push(event);
    if (this.#audit.length > 512) this.#audit.splice(0, this.#audit.length - 512);
  }
}

async function readBoundedFile(input: Record<string, unknown>, signal: AbortSignal) {
  const path = exactPath(input.path);
  const maxBytes = boundedInteger(input.maxBytes, "maxBytes", 1, MAX_READ_BYTES, MAX_READ_BYTES);
  throwIfAborted(signal);
  const metadata = await stat(path);
  if (!metadata.isFile()) throw new Error("Full Access read target is not a file");
  if (metadata.size > maxBytes)
    throw new Error("Full Access file exceeds the requested byte limit");
  const content = await readFile(path, "utf8");
  throwIfAborted(signal);
  return { path, bytes: Buffer.byteLength(content), content };
}

async function writeBoundedFile(input: Record<string, unknown>, signal: AbortSignal) {
  const path = exactPath(input.path);
  const content = stringValue(input.content, "content", true);
  if (Buffer.byteLength(content) > MAX_FILE_BYTES)
    throw new Error("Full Access write exceeds 1 MiB");
  const mode = input.mode ?? "create";
  if (!["create", "overwrite", "append"].includes(String(mode)))
    throw new Error("Full Access write mode is invalid");
  throwIfAborted(signal);
  await mkdir(dirname(path), { recursive: true });
  if (mode === "append") {
    await writeFile(path, content, { encoding: "utf8", flag: "a" });
  } else if (mode === "create") {
    await writeFile(path, content, { encoding: "utf8", flag: "wx" });
  } else {
    const temporary = `${path}.aster-agent-${crypto.randomUUID()}.tmp`;
    try {
      await writeFile(temporary, content, { encoding: "utf8", flag: "wx" });
      throwIfAborted(signal);
      await rm(path, { force: true });
      await rename(temporary, path);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
  }
  return { path, bytesWritten: Buffer.byteLength(content), mode };
}

async function deleteExactPath(input: Record<string, unknown>, signal: AbortSignal) {
  const path = exactPath(input.path);
  throwIfAborted(signal);
  const metadata = await stat(path);
  if (metadata.isDirectory()) await rmdir(path);
  else await rm(path, { force: false });
  return { path, deleted: true, kind: metadata.isDirectory() ? "directory" : "file" };
}

function runBoundedProcess(input: Record<string, unknown>, signal: AbortSignal): Promise<unknown> {
  const executable = stringValue(input.executable, "executable");
  const args = Array.isArray(input.args)
    ? input.args.map((entry) => stringValue(entry, "argument", true))
    : [];
  if (args.length > MAX_PROCESS_ARGS) throw new Error("Full Access process has too many arguments");
  const cwd = input.cwd === undefined ? undefined : exactPath(input.cwd);
  const timeoutMs = boundedInteger(input.timeoutMs, "timeoutMs", 1, MAX_TIMEOUT_MS, 30_000);
  return new Promise((resolveProcess, rejectProcess) => {
    const child = spawn(executable, args, {
      cwd,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputBytes = 0;
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal.removeEventListener("abort", abort);
      callback();
    };
    const abort = () => {
      child.kill();
      finish(() => rejectProcess(new Error("Full Access process was cancelled")));
    };
    const collect = (destination: Buffer[], chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes > MAX_OUTPUT_BYTES) {
        child.kill();
        finish(() => rejectProcess(new Error("Full Access process output exceeded 64 KiB")));
        return;
      }
      destination.push(chunk);
    };
    const timeout = setTimeout(() => {
      child.kill();
      finish(() => rejectProcess(new Error("Full Access process timed out")));
    }, timeoutMs);
    signal.addEventListener("abort", abort, { once: true });
    child.stdout.on("data", (chunk: Buffer) => collect(stdout, chunk));
    child.stderr.on("data", (chunk: Buffer) => collect(stderr, chunk));
    child.once("error", (error) => finish(() => rejectProcess(error)));
    child.once("exit", (code, terminationSignal) =>
      finish(() =>
        resolveProcess({
          executable,
          code,
          signal: terminationSignal,
          stdout: Buffer.concat(stdout).toString("utf8"),
          stderr: Buffer.concat(stderr).toString("utf8"),
        }),
      ),
    );
  });
}

async function boundedNetworkRequest(input: Record<string, unknown>, parentSignal: AbortSignal) {
  const url = new URL(stringValue(input.url, "url"));
  if (!(["https:", "http:"] as const).some((protocol) => protocol === url.protocol))
    throw new Error("Full Access network URL must use HTTP or HTTPS");
  const method = String(input.method ?? "GET").toUpperCase();
  if (!(["GET", "POST", "PUT", "PATCH", "DELETE"] as const).some((value) => value === method))
    throw new Error("Full Access network method is invalid");
  const body = input.body === undefined ? undefined : stringValue(input.body, "body", true);
  if (body && Buffer.byteLength(body) > MAX_FILE_BYTES)
    throw new Error("Full Access request body exceeds 1 MiB");
  const timeoutMs = boundedInteger(input.timeoutMs, "timeoutMs", 1, 30_000, 15_000);
  const controller = new AbortController();
  const abort = () => controller.abort();
  parentSignal.addEventListener("abort", abort, { once: true });
  const timeout = setTimeout(abort, timeoutMs);
  try {
    const response = await fetch(url, {
      method,
      body,
      signal: controller.signal,
      redirect: "manual",
    });
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    if (response.body) {
      for await (const chunk of response.body) {
        bytes += chunk.length;
        if (bytes > MAX_OUTPUT_BYTES) {
          await response.body.cancel();
          throw new Error("Full Access network response exceeded 64 KiB");
        }
        chunks.push(chunk);
      }
    }
    return {
      url: url.toString(),
      status: response.status,
      contentType: response.headers.get("content-type"),
      bytes,
      body: Buffer.concat(chunks).toString("utf8"),
    };
  } finally {
    clearTimeout(timeout);
    parentSignal.removeEventListener("abort", abort);
  }
}

export function describeFullAccessTarget(toolName: string, input: Record<string, unknown>): string {
  if (toolName === "run_process") return String(input.executable ?? "<invalid>").slice(0, 500);
  if (toolName === "network_request") {
    try {
      return new URL(String(input.url)).host;
    } catch {
      return "<invalid>";
    }
  }
  if (toolName === "set_plugin_enabled") return String(input.pluginId ?? "<invalid>").slice(0, 500);
  if (toolName === "set_plugin_safe_mode" || toolName === "set_plugin_hot_reload")
    return "Aster plugin runtime";
  if (toolName === "get_plugin_status") return "Aster plugin status";
  if (toolName === "pack_project") return String(input.destination ?? "<invalid>").slice(0, 500);
  if (toolName === "unpack_project") return String(input.archive ?? "<invalid>").slice(0, 500);
  if (toolName === "link_project_asset") return String(input.source ?? "<invalid>").slice(0, 500);
  if (toolName === "install_plugin") return String(input.source ?? "<invalid>").slice(0, 500);
  return String(input.path ?? "<invalid>").slice(0, 500);
}

function exactPath(value: unknown): string {
  const path = resolve(stringValue(value, "path"));
  const root = parse(path).root;
  if (path === root) throw new Error("Full Access refuses to target a filesystem root");
  return path;
}

function stringValue(value: unknown, name: string, allowEmpty = false): string {
  if (typeof value !== "string" || (!allowEmpty && !value.trim()))
    throw new Error(`${name} must be a string`);
  if (value.length > MAX_FILE_BYTES) throw new Error(`${name} is too large`);
  return value;
}

function boundedInteger(
  value: unknown,
  name: string,
  minimum: number,
  maximum: number,
  fallback: number,
): number {
  if (value === undefined) return fallback;
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  )
    throw new Error(`${name} is outside its bounds`);
  return value;
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new Error("Full Access tool was cancelled");
}
