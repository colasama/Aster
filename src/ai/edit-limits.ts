export const EDIT_LIMITS = Object.freeze({
  commandsPerBatch: 256,
  operationsPerWorkspace: 4096,
  workspaceBytes: 32 * 1024 * 1024,
  idleMs: 30 * 60 * 1000,
  executionMs: 30_000,
  scriptBytes: 256 * 1024,
  resultBytes: 64 * 1024,
  maxWorkspaces: 4,
});

export function encodedBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value) ?? "null").byteLength;
}

export class EditError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "EditError";
  }
}

export function limitExceeded(resource: string, used: number, limit: number): never {
  throw new EditError("budget_exceeded", `${resource} budget exceeded: ${used} > ${limit}`, {
    resource,
    used,
    limit,
    recovery:
      "Reduce this execution or commit the staged workspace and continue in a new workspace.",
  });
}

export function editErrorData(error: unknown) {
  return {
    code: error instanceof EditError ? error.code : "execution_failed",
    message: (error instanceof Error ? error.message : String(error)).slice(0, 2000),
    details: error instanceof EditError ? error.details : {},
  };
}
