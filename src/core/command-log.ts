import type { Operation } from "./operations";
import { createId, type Project, type ProjectCommandEntry } from "./types";

export const MAX_COMMAND_LOG_ENTRIES = 100;
export const MAX_SERIALIZED_COMMAND_SIZE = 32 * 1024;
export const MAX_COMMAND_LOG_SIZE = 256 * 1024;

interface CommandMetadata {
  source?: ProjectCommandEntry["source"];
  summary?: string;
}

export function recordOperations(
  project: Project,
  operations: Operation[],
  metadata: CommandMetadata = {},
): ProjectCommandEntry {
  const operationTypes = operations.map((operation) => operation.type);
  const serialized = JSON.stringify(operations);
  const entry: ProjectCommandEntry = {
    id: createId(),
    at: new Date().toISOString(),
    source: metadata.source ?? "user",
    summary: metadata.summary?.trim() || summarizeOperations(operationTypes),
    operationTypes,
    ...(serialized.length <= MAX_SERIALIZED_COMMAND_SIZE
      ? { serializedOperations: serialized }
      : {}),
  };
  appendEntry(project, entry);
  return entry;
}

export function recordCommandMarker(
  project: Project,
  operationType: "redo" | "undo",
  summary: string,
): ProjectCommandEntry {
  const entry: ProjectCommandEntry = {
    id: createId(),
    at: new Date().toISOString(),
    source: "user",
    summary,
    operationTypes: [operationType],
  };
  appendEntry(project, entry);
  return entry;
}

export function deserializeOperations(entry: ProjectCommandEntry): Operation[] | undefined {
  if (!entry.serializedOperations) return undefined;
  const value: unknown = JSON.parse(entry.serializedOperations);
  if (!Array.isArray(value)) throw new Error("Serialized command must contain an operation array");
  if (
    value.length !== entry.operationTypes.length ||
    value.some(
      (operation, index) =>
        typeof operation !== "object" ||
        operation === null ||
        (operation as { type?: unknown }).type !== entry.operationTypes[index],
    )
  )
    throw new Error("Serialized command operation types do not match its manifest");
  return value as Operation[];
}

function appendEntry(project: Project, entry: ProjectCommandEntry): void {
  const entries = [...project.commandLog, entry].slice(-MAX_COMMAND_LOG_ENTRIES);
  while (entries.length > 1 && JSON.stringify(entries).length > MAX_COMMAND_LOG_SIZE)
    entries.shift();
  project.commandLog = entries;
  project.updatedAt = entry.at;
}

function summarizeOperations(types: string[]): string {
  if (types.length === 0) return "Empty transaction";
  const first = types[0].replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();
  const label = `${first[0].toUpperCase()}${first.slice(1)}`;
  return types.length === 1 ? label : `${label} and ${types.length - 1} more`;
}
