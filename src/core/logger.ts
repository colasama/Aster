import type { DesktopLogEntry, LogLevel } from "../desktop/api";

let globalHandlersInstalled = false;

export const logger = {
  debug(scope: string, event: string, data?: Record<string, unknown>): void {
    emit({ level: "debug", scope, event, data });
  },
  info(scope: string, event: string, data?: Record<string, unknown>): void {
    emit({ level: "info", scope, event, data });
  },
  warn(scope: string, event: string, data?: Record<string, unknown>, error?: unknown): void {
    emit({
      level: "warn",
      scope,
      event,
      data,
      ...(error === undefined ? {} : { error: serializeError(error) }),
    });
  },
  error(scope: string, event: string, error: unknown, data?: Record<string, unknown>): void {
    emit({ level: "error", scope, event, data, error: serializeError(error) });
  },
};

export function installGlobalErrorLogging(): void {
  if (globalHandlersInstalled) return;
  globalHandlersInstalled = true;
  window.addEventListener("error", (event) => {
    logger.error("application", "uncaught_error", event.error ?? event.message, {
      filename: event.filename,
      line: event.lineno,
      column: event.colno,
    });
  });
  window.addEventListener("unhandledrejection", (event) => {
    logger.error("application", "unhandled_rejection", event.reason);
  });
}

function emit(entry: DesktopLogEntry): void {
  if (import.meta.env.DEV || !window.asterDesktop) writeConsole(entry);
  try {
    window.asterDesktop?.log(entry);
  } catch (error) {
    console.error("[Aster logger] Failed to forward renderer log entry", error);
  }
}

function serializeError(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    const cause = (error as Error & { cause?: unknown }).cause;
    return {
      name: error.name,
      message: error.message,
      ...(error.stack ? { stack: error.stack } : {}),
      ...(cause === undefined ? {} : { cause: String(cause) }),
    };
  }
  return { message: typeof error === "string" ? error : String(error) };
}

function writeConsole(entry: DesktopLogEntry): void {
  const message = `[renderer:${entry.scope}] ${entry.event}`;
  const details = entry.error ?? entry.data ?? entry.message ?? "";
  const output: Readonly<Record<LogLevel, (message?: unknown, ...optional: unknown[]) => void>> = {
    debug: console.debug,
    info: console.info,
    warn: console.warn,
    error: console.error,
  };
  output[entry.level](message, details);
}
