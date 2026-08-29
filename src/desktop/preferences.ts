export const CURRENT_APP_PREFERENCES_VERSION = 1 as const;
export const APP_PREFERENCES_CHANGED_EVENT = "aster:preferences-changed";

export type AppLocale = "en-US" | "zh-CN";
export type AutosaveSeconds = 0 | 15 | 30 | 60;
export type GpuMemoryBudgetMb = "auto" | 32 | 64 | 128 | 256 | 512;

export interface PersistedWindowState {
  x: number;
  y: number;
  width: number;
  height: number;
  maximized: boolean;
}

export interface AppPreferences {
  schemaVersion: typeof CURRENT_APP_PREFERENCES_VERSION;
  locale?: AppLocale;
  autosaveSeconds: AutosaveSeconds;
  reducedMotion: boolean;
  gpuMemoryBudgetMb: GpuMemoryBudgetMb;
  recentProjects: string[];
  lastProjectPath?: string;
  windowState?: PersistedWindowState;
}

export type UserPreferencePatch = Partial<
  Pick<AppPreferences, "locale" | "autosaveSeconds" | "reducedMotion" | "gpuMemoryBudgetMb">
>;

const DEFAULT_PREFERENCES: AppPreferences = {
  schemaVersion: CURRENT_APP_PREFERENCES_VERSION,
  autosaveSeconds: 30,
  reducedMotion: false,
  gpuMemoryBudgetMb: "auto",
  recentProjects: [],
};

const AUTOSAVE_INTERVALS = new Set<AutosaveSeconds>([0, 15, 30, 60]);
const GPU_MEMORY_BUDGETS = new Set<GpuMemoryBudgetMb>(["auto", 32, 64, 128, 256, 512]);

export function defaultAppPreferences(): AppPreferences {
  return structuredClone(DEFAULT_PREFERENCES);
}

/**
 * Normalizes every persisted preferences document through one versioned migration boundary.
 * Version zero represents the unversioned shape used while the Electron shell was still an MVP.
 */
export function migrateAppPreferences(value: unknown): AppPreferences {
  if (!isRecord(value)) return defaultAppPreferences();
  const schemaVersion = value.schemaVersion ?? 0;
  if (!Number.isSafeInteger(schemaVersion) || Number(schemaVersion) < 0)
    throw new Error("Application preferences schema version is invalid");
  if (Number(schemaVersion) > CURRENT_APP_PREFERENCES_VERSION)
    throw new Error(`Application preferences v${String(schemaVersion)} are newer than this build`);

  let document: Record<string, unknown> = structuredClone(value);
  let version = Number(schemaVersion);
  while (version < CURRENT_APP_PREFERENCES_VERSION) {
    const migrate = APP_PREFERENCE_MIGRATIONS.get(version);
    if (!migrate) throw new Error(`No application preferences migration exists for v${version}`);
    document = migrate(document);
    version += 1;
  }
  return normalizeCurrentPreferences(document);
}

export function applyUserPreferencePatch(current: AppPreferences, value: unknown): AppPreferences {
  if (!isRecord(value)) throw new Error("Application preferences update must be an object");
  const allowed = new Set(["locale", "autosaveSeconds", "reducedMotion", "gpuMemoryBudgetMb"]);
  for (const key of Object.keys(value))
    if (!allowed.has(key)) throw new Error(`Application preference ${key} cannot be updated here`);
  return normalizeCurrentPreferences({ ...current, ...value });
}

export function rememberRecentProject(current: AppPreferences, path: string): AppPreferences {
  const normalizedPath = boundedPath(path);
  if (!normalizedPath) return current;
  return {
    ...current,
    lastProjectPath: normalizedPath,
    recentProjects: [
      normalizedPath,
      ...current.recentProjects.filter(
        (candidate) => candidate.toLocaleLowerCase() !== normalizedPath.toLocaleLowerCase(),
      ),
    ].slice(0, 10),
  };
}

export function forgetRecentProject(current: AppPreferences, path: string): AppPreferences {
  const normalizedPath = boundedPath(path);
  if (!normalizedPath) return current;
  const key = normalizedPath.toLocaleLowerCase();
  return {
    ...current,
    recentProjects: current.recentProjects.filter(
      (candidate) => candidate.toLocaleLowerCase() !== key,
    ),
    ...(current.lastProjectPath?.toLocaleLowerCase() === key ? { lastProjectPath: undefined } : {}),
  };
}

const APP_PREFERENCE_MIGRATIONS = new Map<
  number,
  (document: Record<string, unknown>) => Record<string, unknown>
>([
  [
    0,
    (document) => ({
      ...document,
      schemaVersion: 1,
      autosaveSeconds: document.autosaveSeconds ?? 30,
      reducedMotion: document.reducedMotion ?? false,
      gpuMemoryBudgetMb: document.gpuMemoryBudgetMb ?? "auto",
      recentProjects: document.recentProjects ?? [],
    }),
  ],
]);

function normalizeCurrentPreferences(value: Record<string, unknown>): AppPreferences {
  const autosaveSeconds = AUTOSAVE_INTERVALS.has(value.autosaveSeconds as AutosaveSeconds)
    ? (value.autosaveSeconds as AutosaveSeconds)
    : 30;
  const gpuMemoryBudgetMb = GPU_MEMORY_BUDGETS.has(value.gpuMemoryBudgetMb as GpuMemoryBudgetMb)
    ? (value.gpuMemoryBudgetMb as GpuMemoryBudgetMb)
    : "auto";
  const locale = value.locale === "en-US" || value.locale === "zh-CN" ? value.locale : undefined;
  const recentProjects = Array.isArray(value.recentProjects)
    ? [
        ...new Map(
          value.recentProjects
            .map(boundedPath)
            .filter((path): path is string => Boolean(path))
            .map((path) => [path.toLocaleLowerCase(), path]),
        ).values(),
      ].slice(0, 10)
    : [];
  const lastProjectPath = boundedPath(value.lastProjectPath);
  const windowState = normalizeWindowState(value.windowState);
  return {
    schemaVersion: CURRENT_APP_PREFERENCES_VERSION,
    ...(locale ? { locale } : {}),
    autosaveSeconds,
    reducedMotion: value.reducedMotion === true,
    gpuMemoryBudgetMb,
    recentProjects,
    ...(lastProjectPath ? { lastProjectPath } : {}),
    ...(windowState ? { windowState } : {}),
  };
}

function normalizeWindowState(value: unknown): PersistedWindowState | undefined {
  if (!isRecord(value)) return undefined;
  const fields = [value.x, value.y, value.width, value.height];
  if (!fields.every((field) => typeof field === "number" && Number.isFinite(field)))
    return undefined;
  const width = Math.round(value.width as number);
  const height = Math.round(value.height as number);
  if (width < 640 || height < 480 || width > 32_768 || height > 32_768) return undefined;
  return {
    x: Math.round(value.x as number),
    y: Math.round(value.y as number),
    width,
    height,
    maximized: value.maximized === true,
  };
}

function boundedPath(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const path = value.trim();
  return path && path.length <= 4_096 ? path : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
