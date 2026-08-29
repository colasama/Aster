import { logger } from "../core/logger";
import type { Translate } from "../i18n/core";
import { type UiErrorCode, uiErrorMessage } from "../i18n/errors";
import type { DiagnosticScope, DiagnosticSeverity, EditorDiagnostic } from "./diagnostic";
import { type DiagnosticStore, diagnosticStore } from "./diagnostic-store";

export interface ReportUiErrorOptions {
  readonly scope?: DiagnosticScope;
  readonly severity?: DiagnosticSeverity;
  readonly persistent?: boolean;
  readonly retry?: () => void | Promise<void>;
  readonly store?: DiagnosticStore;
}

/**
 * Promotes a caught user-action failure into a correlated, inspectable diagnostic.
 * Expected cancellation is deliberately silent and never pollutes diagnostics or logs.
 */
export function reportUiError(
  t: Translate,
  code: UiErrorCode,
  error: unknown,
  options: ReportUiErrorOptions = {},
): EditorDiagnostic | undefined {
  if (isExpectedCancellation(error)) return undefined;
  const store = options.store ?? diagnosticStore;
  const scope = options.scope ?? { area: "application" };
  const title = uiErrorMessage(t, code);
  let diagnosticId: string | undefined;
  const retry = options.retry
    ? async () => {
        await options.retry?.();
        if (diagnosticId) store.resolve(diagnosticId);
      }
    : undefined;
  const diagnostic = store.report(
    {
      code: `ui_${toSnakeCase(code)}_failed`,
      title,
      message: specificErrorMessage(error, title),
      severity: options.severity ?? "error",
      scope,
      error,
      ...(options.persistent === undefined ? {} : { persistent: options.persistent }),
      actions: [
        ...(retry ? [{ id: "retry", kind: "retry" as const, label: t("diagnostic.retry") }] : []),
        { id: "details", kind: "details", label: t("diagnostic.details") },
        { id: "copy", kind: "copy", label: t("diagnostic.copy") },
      ],
    },
    retry ? { actionHandlers: { retry } } : {},
  );
  diagnosticId = diagnostic.id;
  logger.error(`ui.${scope.area}`, `${toSnakeCase(code)}_failed`, error, {
    correlationId: diagnostic.correlationId,
    diagnosticCode: diagnostic.code,
    ...scope,
  });
  return diagnostic;
}

export function isExpectedCancellation(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function specificErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error) return error.message.trim() || fallback;
  if (typeof error === "string") return error.trim() || fallback;
  try {
    const serialized = JSON.stringify(error);
    return serialized && serialized !== "{}" ? serialized : fallback;
  } catch {
    return fallback;
  }
}

function toSnakeCase(value: string): string {
  return value.replace(/[A-Z]/g, (character) => `_${character.toLowerCase()}`);
}
