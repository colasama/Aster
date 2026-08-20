import { randomUUID } from "node:crypto";
import { appendFile, mkdir, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";

export type LogLevel = "debug" | "info" | "warn" | "error";
export type LogProcess = "main" | "renderer" | "bridge";

export interface RendererLogPayload {
  level: LogLevel;
  scope: string;
  event: string;
  message?: string;
  data?: Record<string, unknown>;
  error?: unknown;
}

export interface LogEntry extends RendererLogPayload {
  timestamp: string;
  sequence: number;
  sessionId: string;
  process: LogProcess;
}

interface LoggerOptions {
  directory: string;
  level: LogLevel;
  maxBytes?: number;
  maxFiles?: number;
  console?: boolean;
}

const LEVEL_PRIORITY: Readonly<Record<LogLevel, number>> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};
const REDACTED_KEY = /(?:authorization|password|secret|token|api[_-]?key)/i;
const MAX_STRING_LENGTH = 4_096;
const MAX_COLLECTION_ENTRIES = 50;
const MAX_DEPTH = 5;

export class AsterLogger {
  readonly sessionId = randomUUID();
  readonly filePath: string;
  readonly #directory: string;
  readonly #level: LogLevel;
  readonly #maxBytes: number;
  readonly #maxFiles: number;
  readonly #console: boolean;
  #bytes = 0;
  #sequence = 0;
  #initialized = false;
  #queue: Promise<void> = Promise.resolve();

  constructor(options: LoggerOptions) {
    this.#directory = options.directory;
    this.#level = options.level;
    this.#maxBytes = options.maxBytes ?? 5 * 1024 * 1024;
    this.#maxFiles = Math.max(1, options.maxFiles ?? 5);
    this.#console = options.console ?? true;
    this.filePath = join(options.directory, "aster.jsonl");
  }

  async initialize(): Promise<void> {
    await mkdir(this.#directory, { recursive: true });
    const metadata = await stat(this.filePath).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    this.#bytes = metadata?.size ?? 0;
    if (this.#bytes >= this.#maxBytes) await this.#rotate();
    this.#initialized = true;
  }

  debug(scope: string, event: string, data?: Record<string, unknown>): void {
    this.#emit("debug", "main", scope, event, undefined, data);
  }

  info(scope: string, event: string, data?: Record<string, unknown>): void {
    this.#emit("info", "main", scope, event, undefined, data);
  }

  warn(scope: string, event: string, data?: Record<string, unknown>): void {
    this.#emit("warn", "main", scope, event, undefined, data);
  }

  error(scope: string, event: string, error: unknown, data?: Record<string, unknown>): void {
    this.#emit("error", "main", scope, event, undefined, data, error);
  }

  ingestRenderer(payload: RendererLogPayload, rendererId: number): void {
    this.#emit(
      payload.level,
      "renderer",
      payload.scope,
      payload.event,
      payload.message,
      { ...payload.data, rendererId },
      payload.error,
    );
  }

  ingestBridge(line: string): void {
    let value: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(line);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
      value = parsed as Record<string, unknown>;
    } catch {
      this.#emit("warn", "bridge", "stderr", "unstructured_output", line);
      return;
    }
    const fields =
      value.fields && typeof value.fields === "object" && !Array.isArray(value.fields)
        ? (value.fields as Record<string, unknown>)
        : value;
    const level = normalizeLevel(value.level);
    const target = typeof value.target === "string" ? value.target : "bridge";
    const message = typeof fields.message === "string" ? fields.message : undefined;
    const event = typeof fields.event === "string" ? fields.event : "trace";
    const data = { ...fields };
    delete data.message;
    delete data.event;
    if (typeof value.timestamp === "string") data.bridgeTimestamp = value.timestamp;
    this.#emit(level, "bridge", target, event, message, data);
  }

  async flush(): Promise<void> {
    await this.#queue;
  }

  #emit(
    level: LogLevel,
    processRole: LogProcess,
    scope: string,
    event: string,
    message?: string,
    data?: Record<string, unknown>,
    error?: unknown,
  ): void {
    if (LEVEL_PRIORITY[level] < LEVEL_PRIORITY[this.#level]) return;
    this.#sequence += 1;
    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      sequence: this.#sequence,
      sessionId: this.sessionId,
      process: processRole,
      level,
      scope: boundedLabel(scope, "application"),
      event: boundedLabel(event, "event"),
      ...(message ? { message: boundedString(message) } : {}),
      ...(data ? { data: sanitizeRecord(data) } : {}),
      ...(error === undefined ? {} : { error: sanitizeError(error) }),
    };
    if (this.#console) writeConsole(entry);
    if (!this.#initialized) return;
    const line = `${JSON.stringify(entry)}\n`;
    const lineBytes = Buffer.byteLength(line);
    this.#queue = this.#queue
      .then(async () => {
        if (this.#bytes > 0 && this.#bytes + lineBytes > this.#maxBytes) await this.#rotate();
        await appendFile(this.filePath, line, "utf8");
        this.#bytes += lineBytes;
      })
      .catch((writeError: unknown) => {
        console.error("[Aster logger] Failed to write the application log", writeError);
      });
  }

  async #rotate(): Promise<void> {
    if (this.#maxFiles > 1) {
      await rm(this.#archivePath(this.#maxFiles - 1), { force: true });
      for (let index = this.#maxFiles - 2; index >= 1; index -= 1) {
        await rename(this.#archivePath(index), this.#archivePath(index + 1)).catch(
          (error: NodeJS.ErrnoException) => {
            if (error.code !== "ENOENT") throw error;
          },
        );
      }
      await rename(this.filePath, this.#archivePath(1)).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      });
    } else {
      await rm(this.filePath, { force: true });
    }
    this.#bytes = 0;
  }

  #archivePath(index: number): string {
    return join(this.#directory, `aster.${index}.jsonl`);
  }
}

export function parseLogLevel(value: string | undefined, fallback: LogLevel): LogLevel {
  const normalized = value?.trim().toLowerCase();
  return normalized === "debug" ||
    normalized === "info" ||
    normalized === "warn" ||
    normalized === "error"
    ? normalized
    : fallback;
}

export function isRendererLogPayload(value: unknown): value is RendererLogPayload {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Partial<RendererLogPayload>;
  if (
    !candidate.level ||
    !(candidate.level in LEVEL_PRIORITY) ||
    typeof candidate.scope !== "string" ||
    typeof candidate.event !== "string" ||
    candidate.scope.length > 100 ||
    candidate.event.length > 100
  )
    return false;
  if (candidate.message !== undefined && typeof candidate.message !== "string") return false;
  if (
    candidate.data !== undefined &&
    (!candidate.data || typeof candidate.data !== "object" || Array.isArray(candidate.data))
  )
    return false;
  return true;
}

function normalizeLevel(value: unknown): LogLevel {
  if (typeof value !== "string") return "info";
  const normalized = value.toLowerCase();
  if (normalized === "debug" || normalized === "warn" || normalized === "error") return normalized;
  return "info";
}

function boundedLabel(value: string, fallback: string): string {
  const normalized = value.trim();
  return boundedString(normalized || fallback, 100);
}

function boundedString(value: string, maximum = MAX_STRING_LENGTH): string {
  return value.length <= maximum ? value : `${value.slice(0, maximum)}…[truncated]`;
}

function sanitizeRecord(value: Record<string, unknown>): Record<string, unknown> {
  return sanitizeValue(value, 0, new WeakSet<object>()) as Record<string, unknown>;
}

function sanitizeValue(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (value === null || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") return boundedString(value);
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "undefined") return undefined;
  if (typeof value !== "object") return boundedString(String(value));
  if (value instanceof Error) return sanitizeError(value);
  if (depth >= MAX_DEPTH) return "[MAX_DEPTH]";
  if (seen.has(value)) return "[CIRCULAR]";
  seen.add(value);
  if (Array.isArray(value)) {
    const result = value
      .slice(0, MAX_COLLECTION_ENTRIES)
      .map((entry) => sanitizeValue(entry, depth + 1, seen));
    if (value.length > MAX_COLLECTION_ENTRIES) result.push(`[${value.length} entries total]`);
    return result;
  }
  const result: Record<string, unknown> = {};
  const entries = Object.entries(value).slice(0, MAX_COLLECTION_ENTRIES);
  for (const [key, entry] of entries) {
    result[key] = REDACTED_KEY.test(key) ? "[REDACTED]" : sanitizeValue(entry, depth + 1, seen);
  }
  if (Object.keys(value).length > entries.length) result._truncated = true;
  return result;
}

function sanitizeError(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    return {
      name: boundedString(error.name, 200),
      message: boundedString(error.message),
      ...(error.stack ? { stack: boundedString(error.stack, 16_384) } : {}),
      ...(error.cause === undefined
        ? {}
        : { cause: sanitizeValue(error.cause, 1, new WeakSet<object>()) }),
    };
  }
  if (error && typeof error === "object" && !Array.isArray(error)) {
    return sanitizeRecord(error as Record<string, unknown>);
  }
  return { message: boundedString(typeof error === "string" ? error : String(error)) };
}

function writeConsole(entry: LogEntry): void {
  const message = `[${entry.process}:${entry.scope}] ${entry.event}`;
  const details = entry.error ?? entry.data ?? entry.message;
  if (entry.level === "error") console.error(message, details ?? "");
  else if (entry.level === "warn") console.warn(message, details ?? "");
  else if (entry.level === "debug") console.debug(message, details ?? "");
  else console.info(message, details ?? "");
}
