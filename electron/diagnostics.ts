import { open, readFile, rename, rm } from "node:fs/promises";
import type { AppPreferences } from "../src/desktop/preferences.js";

const MAX_LOG_BYTES = 1024 * 1024;
const MAX_LOG_ENTRIES = 250;

export interface DiagnosticBundleInput {
  version: string;
  platform: NodeJS.Platform;
  architecture: string;
  gpuFeatureStatus: unknown;
  gpuInfo: unknown;
  preferences: AppPreferences;
  logFile: string;
}

export async function createDiagnosticBundle(input: DiagnosticBundleInput): Promise<unknown> {
  return {
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    application: {
      name: "Aster",
      version: input.version,
      platform: input.platform,
      architecture: input.architecture,
    },
    gpu: {
      featureStatus: boundedValue(input.gpuFeatureStatus),
      info: boundedValue(input.gpuInfo),
    },
    preferences: {
      locale: input.preferences.locale,
      autosaveSeconds: input.preferences.autosaveSeconds,
      reducedMotion: input.preferences.reducedMotion,
      gpuMemoryBudgetMb: input.preferences.gpuMemoryBudgetMb,
    },
    logs: await readRecentLogs(input.logFile),
  };
}

export async function writeDiagnosticBundle(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.tmp`;
  const file = await open(temporary, "w");
  try {
    await file.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await file.sync();
  } finally {
    await file.close();
  }
  await rm(path, { force: true });
  try {
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

async function readRecentLogs(path: string): Promise<unknown[]> {
  let bytes: Buffer;
  try {
    bytes = await readFile(path);
  } catch {
    return [];
  }
  const tail = bytes.subarray(Math.max(0, bytes.byteLength - MAX_LOG_BYTES)).toString("utf8");
  const lines = tail.split(/\r?\n/u).filter(Boolean);
  if (bytes.byteLength > MAX_LOG_BYTES) lines.shift();
  return lines.slice(-MAX_LOG_ENTRIES).flatMap((line) => {
    try {
      return [boundedValue(JSON.parse(line))];
    } catch {
      return [];
    }
  });
}

function boundedValue(value: unknown, depth = 0): unknown {
  if (depth >= 6) return "[truncated]";
  if (typeof value === "string") return value.slice(0, 4_096);
  if (typeof value === "number" || typeof value === "boolean" || value === null) return value;
  if (Array.isArray(value))
    return value.slice(0, 100).map((entry) => boundedValue(entry, depth + 1));
  if (!value || typeof value !== "object") return String(value);
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .slice(0, 100)
      .map(([key, entry]) => [key.slice(0, 128), boundedValue(entry, depth + 1)]),
  );
}
