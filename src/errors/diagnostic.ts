import type { Id } from "../core/types";

export type DiagnosticSeverity = "info" | "warning" | "error" | "fatal";
export type DiagnosticStatus = "active" | "resolved" | "dismissed";

export interface DiagnosticScope {
  area: "application" | "project" | "composition" | "layer" | "property" | "asset" | "render";
  projectId?: Id;
  compositionId?: Id;
  layerId?: Id;
  propertyPath?: string;
  assetName?: string;
  renderJobId?: Id;
}

export type DiagnosticAction =
  | { id: string; kind: "retry"; label: string }
  | { id: string; kind: "reveal"; label: string; scope: DiagnosticScope }
  | { id: string; kind: "help"; label: string; url: string }
  | { id: string; kind: "details"; label: string }
  | { id: string; kind: "copy"; label: string };

export interface ErrorDetails {
  name: string;
  message: string;
  stack?: string;
  cause?: ErrorDetails;
}

export interface EditorDiagnostic {
  id: Id;
  correlationId: Id;
  code: string;
  title: string;
  message: string;
  severity: DiagnosticSeverity;
  status: DiagnosticStatus;
  scope: DiagnosticScope;
  actions: DiagnosticAction[];
  details?: ErrorDetails;
  firstSeenAt: string;
  lastSeenAt: string;
  occurrences: number;
  persistent: boolean;
}

export interface DiagnosticInput {
  code: string;
  title: string;
  message?: string;
  severity?: DiagnosticSeverity;
  scope?: DiagnosticScope;
  actions?: DiagnosticAction[];
  error?: unknown;
  persistent?: boolean;
  correlationId?: Id;
}

const MAX_CODE_LENGTH = 96;
const MAX_TITLE_LENGTH = 180;
const MAX_MESSAGE_LENGTH = 2_048;
const MAX_STACK_LENGTH = 12_000;
const MAX_ACTIONS = 8;
const MAX_CAUSE_DEPTH = 3;

export function createDiagnostic(
  input: DiagnosticInput,
  now = new Date(),
  createId: () => Id = defaultId,
): EditorDiagnostic {
  const details = serializeError(input.error);
  const message = boundedText(input.message ?? details?.message ?? input.title, MAX_MESSAGE_LENGTH);
  const at = now.toISOString();
  const severity = input.severity ?? "error";
  return {
    id: createId(),
    correlationId: input.correlationId ?? createId(),
    code: boundedText(input.code, MAX_CODE_LENGTH) || "unknown_error",
    title: boundedText(input.title, MAX_TITLE_LENGTH) || "Unexpected error",
    message,
    severity,
    status: "active",
    scope: normalizeScope(input.scope),
    actions: normalizeActions(input.actions),
    ...(details ? { details } : {}),
    firstSeenAt: at,
    lastSeenAt: at,
    occurrences: 1,
    persistent: input.persistent ?? severity === "fatal",
  };
}

export function diagnosticFingerprint(diagnostic: EditorDiagnostic): string {
  const scope = diagnostic.scope;
  return [
    diagnostic.code,
    diagnostic.message,
    scope.area,
    scope.projectId,
    scope.compositionId,
    scope.layerId,
    scope.propertyPath,
    scope.assetName,
    scope.renderJobId,
  ]
    .map((value) => value ?? "")
    .join("\u0000");
}

export function serializeError(value: unknown, depth = 0): ErrorDetails | undefined {
  if (value === undefined || value === null || depth >= MAX_CAUSE_DEPTH) return undefined;
  if (value instanceof Error) {
    const cause = serializeError((value as Error & { cause?: unknown }).cause, depth + 1);
    return {
      name: boundedText(value.name || "Error", MAX_TITLE_LENGTH),
      message: boundedText(value.message || String(value), MAX_MESSAGE_LENGTH),
      ...(value.stack ? { stack: boundedText(value.stack, MAX_STACK_LENGTH) } : {}),
      ...(cause ? { cause } : {}),
    };
  }
  if (typeof value === "string")
    return { name: "Error", message: boundedText(value, MAX_MESSAGE_LENGTH) };
  return {
    name: "NonErrorThrown",
    message: boundedText(safeStringify(value), MAX_MESSAGE_LENGTH),
  };
}

export function severityRank(severity: DiagnosticSeverity): number {
  return { info: 0, warning: 1, error: 2, fatal: 3 }[severity];
}

function normalizeScope(scope: DiagnosticScope | undefined): DiagnosticScope {
  if (!scope) return { area: "application" };
  return {
    area: scope.area,
    ...(boundedOptional(scope.projectId, 128)
      ? { projectId: boundedOptional(scope.projectId, 128) }
      : {}),
    ...(boundedOptional(scope.compositionId, 128)
      ? { compositionId: boundedOptional(scope.compositionId, 128) }
      : {}),
    ...(boundedOptional(scope.layerId, 128)
      ? { layerId: boundedOptional(scope.layerId, 128) }
      : {}),
    ...(boundedOptional(scope.propertyPath, 256)
      ? { propertyPath: boundedOptional(scope.propertyPath, 256) }
      : {}),
    ...(boundedOptional(scope.assetName, 512)
      ? { assetName: boundedOptional(scope.assetName, 512) }
      : {}),
    ...(boundedOptional(scope.renderJobId, 128)
      ? { renderJobId: boundedOptional(scope.renderJobId, 128) }
      : {}),
  };
}

function normalizeActions(actions: readonly DiagnosticAction[] | undefined): DiagnosticAction[] {
  if (!actions) return [];
  const ids = new Set<string>();
  const normalized: DiagnosticAction[] = [];
  for (const action of actions) {
    const id = boundedText(action.id, 96);
    if (!id || ids.has(id)) continue;
    ids.add(id);
    const label = boundedText(action.label, 120);
    if (!label) continue;
    if (action.kind === "help") {
      const url = safeHelpUrl(action.url);
      if (!url) continue;
      normalized.push({ id, kind: "help", label, url });
    } else if (action.kind === "reveal") {
      normalized.push({ id, kind: "reveal", label, scope: normalizeScope(action.scope) });
    } else {
      normalized.push({ id, kind: action.kind, label });
    }
    if (normalized.length >= MAX_ACTIONS) break;
  }
  return normalized;
}

function safeHelpUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

function boundedOptional(value: string | undefined, maximum: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const bounded = boundedText(value, maximum);
  return bounded || undefined;
}

function boundedText(value: string, maximum: number): string {
  const normalized = String(value).split("\u0000").join("").trim();
  return normalized.length > maximum ? `${normalized.slice(0, maximum - 1)}…` : normalized;
}

function defaultId(): Id {
  return crypto.randomUUID();
}
