import {
  convertFileSrc,
  forgetActiveProject,
  invoke,
  isDesktopRuntime,
  open,
  save,
} from "../../desktop/api";

import {
  createPersistedMediaImports,
  hydratePersistedMediaImports,
  type MediaImportPersistenceMode,
  type PersistedMediaImports,
} from "../../importers/media-import-persistence";

import { mediaImportRuntime } from "../../importers/media-import-runtime";

import { logger } from "../logger";

import { copySourceWithoutRuntimeUrl } from "../media/footage-source";

import { prepareProjectFonts } from "../media/project-font-runtime";

import { runCpuTask } from "../scheduling/cpu-scheduler";

import type { FootageSource, Project } from "../types";

import { validateProjectDocument } from "./validation/document";
import { MAX_EMBEDDED_ASSET_CHARACTERS } from "./validation/sources";

const RECOVERY_KEY = "aster.recoveryProject.v0";

let nativeProjectPath: string | undefined;

let nativeAutosaveFailureReported = false;

let nativePersistenceQueue: Promise<void> = Promise.resolve();

interface RecoveryStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export function serializeProject(project: Project): string {
  return `${JSON.stringify(projectDocumentForPersistence(project), null, 2)}\n`;
}

export async function downloadProject(project: Project): Promise<void> {
  const document = await projectDocumentWithMediaImports(project, "portable");
  const serialized = await runCpuTask(
    {
      kind: "serialize-json",
      maxOutputCharacters: MAX_EMBEDDED_ASSET_CHARACTERS + 16 * 1024 * 1024,
      spacing: 2,
      trailingNewline: true,
      value: document,
    },
    { priority: "interactive" },
  );
  downloadBlob(
    new Blob([serialized], { type: "application/json" }),
    `${safeFileName(project.name)}.aster.json`,
  );
}

export async function saveProjectDocument(
  project: Project,
  chooseDirectory = false,
  destinationPath?: string,
): Promise<string | undefined> {
  const startedAt = performance.now();
  if (!isDesktopRuntime()) {
    await downloadProject(project);
    await clearRecoverySnapshot();
    logger.info("project", "downloaded", {
      compositionCount: project.compositions.length,
      durationMs: performance.now() - startedAt,
    });
    return `${safeFileName(project.name)}.aster.json`;
  }
  const previousPath = nativeProjectPath;
  if (destinationPath) nativeProjectPath = destinationPath;
  else if (chooseDirectory || !nativeProjectPath) {
    const selected = await open({
      directory: true,
      multiple: false,
      title: chooseDirectory ? "Save Aster project as…" : "Choose an Aster project folder",
    });
    if (typeof selected !== "string") return undefined;
    nativeProjectPath = selected;
  }
  const destination = nativeProjectPath;
  try {
    const document = await projectDocumentWithMediaImports(project, "native");
    await queueNativePersistence(async () => {
      await invoke("save_project", {
        path: destination,
        project: document,
      });
      await invoke("clear_autosave", { path: destination });
    });
  } catch (error) {
    nativeProjectPath = previousPath;
    throw error;
  }
  removeBrowserRecoverySnapshot();
  logger.info("project", "saved", {
    compositionCount: project.compositions.length,
    durationMs: performance.now() - startedAt,
  });
  return nativeProjectPath;
}

export async function pickProjectFile(
  beforeLoad?: () => Promise<boolean>,
): Promise<{ project: Project; name: string } | undefined> {
  if (isDesktopRuntime()) {
    const selected = await open({
      directory: true,
      multiple: false,
      title: "Open an Aster project folder",
    });
    if (typeof selected !== "string") return undefined;
    if (beforeLoad && !(await beforeLoad())) return undefined;
    const project = await openPersistedProjectDocument(
      hydrateRuntimeAssetUrls(await invoke("load_project", { path: selected })),
      true,
    );
    nativeProjectPath = selected;
    logger.info("project", "loaded", { compositionCount: project.compositions.length });
    return { project, name: selected.split(/[\\/]/).pop() || selected };
  }
  const picker = document.createElement("input");
  picker.type = "file";
  picker.accept = ".json,.aster.json,application/json";
  return new Promise((resolve, reject) => {
    picker.addEventListener(
      "change",
      async () => {
        const file = picker.files?.[0];
        if (!file) {
          resolve(undefined);
          return;
        }
        try {
          if (beforeLoad && !(await beforeLoad())) {
            resolve(undefined);
            return;
          }
          const project = await openPersistedProjectDocument(JSON.parse(await file.text()), false);
          logger.info("project", "loaded", { compositionCount: project.compositions.length });
          resolve({
            project,
            name: file.name,
          });
        } catch (error) {
          reject(error);
        }
      },
      { once: true },
    );
    picker.click();
  });
}

export async function loadProjectFromPath(
  path: string,
  commit?: { assertCurrent: () => void; loaded: (project: Project) => void },
): Promise<{ project: Project; name: string }> {
  if (!isDesktopRuntime())
    throw new Error("System project opening requires the desktop application");
  const project = await openPersistedProjectDocument(
    hydrateRuntimeAssetUrls(await invoke("load_project", { path })),
    true,
    {
      beforeCommit: commit?.assertCurrent,
      loaded: (project) => {
        nativeProjectPath = path;
        commit?.loaded(project);
      },
    },
  );
  logger.info("project", "loaded", { compositionCount: project.compositions.length });
  return { project, name: path.split(/[\\/]/).pop() || path };
}

export async function openProjectFromSystemPath(
  path: string,
  beforeLoad?: () => Promise<boolean>,
): Promise<{ project: Project; name: string } | undefined> {
  if (path.toLocaleLowerCase().endsWith(".aster")) return unpackPackedProject(path, beforeLoad);
  if (beforeLoad && !(await beforeLoad())) return undefined;
  return loadProjectFromPath(path);
}

export function clearCurrentProjectPath(): void {
  nativeProjectPath = undefined;
  mediaImportRuntime.clear();
  if (isDesktopRuntime()) void forgetActiveProject();
}

export async function packCurrentProject(projectName: string): Promise<string | undefined> {
  if (!nativeProjectPath || !isDesktopRuntime())
    throw new Error("Save this project in the native app before packing it");
  const destination = await save({
    title: "Pack Aster project",
    defaultPath: `${safeFileName(projectName)}.aster`,
    filters: [{ name: "Aster packed project", extensions: ["aster"] }],
  });
  if (!destination) return undefined;
  await invoke("pack_project", { bundle: nativeProjectPath, destination });
  return destination;
}

export async function pickPackedProject(
  beforeLoad?: () => Promise<boolean>,
): Promise<{ project: Project; name: string } | undefined> {
  if (!isDesktopRuntime())
    throw new Error("Packed projects are available in the native Aster application");
  const archive = await open({
    directory: false,
    multiple: false,
    title: "Open packed Aster project",
    filters: [{ name: "Aster packed project", extensions: ["aster"] }],
  });
  if (typeof archive !== "string") return undefined;
  return unpackPackedProject(archive, beforeLoad);
}

async function unpackPackedProject(
  archive: string,
  beforeLoad?: () => Promise<boolean>,
): Promise<{ project: Project; name: string } | undefined> {
  const parent = await open({
    directory: true,
    multiple: false,
    title: "Choose where to unpack the project",
  });
  if (typeof parent !== "string") return undefined;
  if (beforeLoad && !(await beforeLoad())) return undefined;
  const destination = await invoke<string>("unpack_project", { archive, parent });
  const project = await openPersistedProjectDocument(
    hydrateRuntimeAssetUrls(await invoke("load_project", { path: destination })),
    true,
  );
  nativeProjectPath = destination;
  logger.info("project", "packed_project_loaded", {
    compositionCount: project.compositions.length,
  });
  return { project, name: destination.split(/[\\/]/).pop() || destination };
}

export async function storeRecoverySnapshot(
  project: Project,
  storage: RecoveryStorage = localStorage,
): Promise<void> {
  const autosavePath = nativeProjectPath;
  let nativeError: unknown;
  if (autosavePath) {
    try {
      const document = await projectDocumentWithMediaImports(project, "native");
      await queueNativePersistence(() =>
        invoke("save_autosave", {
          path: autosavePath,
          project: document,
        }),
      );
      nativeAutosaveFailureReported = false;
      removeBrowserRecoverySnapshot(storage);
      return;
    } catch (error) {
      nativeError = error;
      if (!nativeAutosaveFailureReported) {
        nativeAutosaveFailureReported = true;
        logger.warn("project", "native_autosave_failed", undefined, error);
      }
    }
  }
  try {
    storage.setItem(
      RECOVERY_KEY,
      `${JSON.stringify(await projectDocumentWithMediaImports(project, "portable"), null, 2)}\n`,
    );
  } catch (error) {
    removeBrowserRecoverySnapshot(storage);
    throw nativeError ?? error;
  }
}

export async function readRecoverySnapshot(
  storage: RecoveryStorage = localStorage,
): Promise<Project | undefined> {
  const document = storage.getItem(RECOVERY_KEY);
  if (!document) return undefined;
  try {
    return await openPersistedProjectDocument(JSON.parse(document), false);
  } catch {
    storage.removeItem(RECOVERY_KEY);
    return undefined;
  }
}

export async function readRecoverySnapshotForCurrentProject(): Promise<Project | undefined> {
  return (await readNativeRecoverySnapshotForCurrentProject()) ?? (await readRecoverySnapshot());
}

export async function readNativeRecoverySnapshotForCurrentProject(): Promise<Project | undefined> {
  if (!nativeProjectPath) return undefined;
  const candidate = await invoke<unknown>("recovery_candidate", {
    path: nativeProjectPath,
  });
  return candidate
    ? await openPersistedProjectDocument(hydrateRuntimeAssetUrls(candidate), true)
    : undefined;
}

export async function clearRecoverySnapshot(
  storage: RecoveryStorage = localStorage,
): Promise<void> {
  removeBrowserRecoverySnapshot(storage);
  const autosavePath = nativeProjectPath;
  if (autosavePath)
    await queueNativePersistence(() => invoke("clear_autosave", { path: autosavePath })).catch(
      () => undefined,
    );
}

function removeBrowserRecoverySnapshot(storage: RecoveryStorage = localStorage): void {
  try {
    storage.removeItem(RECOVERY_KEY);
  } catch {
    // Recovery cleanup must not interrupt a completed primary save or a document transition.
  }
}

function queueNativePersistence(task: () => Promise<unknown>): Promise<void> {
  const queued = nativePersistenceQueue.then(task, task).then(() => undefined);
  nativePersistenceQueue = queued.catch(() => undefined);
  return queued;
}

export async function relinkProjectSource(
  source: FootageSource,
): Promise<FootageSource | undefined> {
  if (!nativeProjectPath || !isDesktopRuntime())
    throw new Error("Save or open this project in the native app before linking an asset");
  if (source.kind !== "still" && source.kind !== "video" && source.kind !== "audio")
    throw new Error("Only still, video, and audio sources can link project assets");
  const selected = await open({
    directory: false,
    multiple: false,
    title: `Link ${source.kind} source`,
    filters: [
      {
        name: source.kind === "still" ? "Images" : source.kind === "video" ? "Videos" : "Audio",
        extensions:
          source.kind === "still"
            ? ["png", "jpg", "jpeg", "webp", "gif", "bmp", "avif"]
            : source.kind === "video"
              ? ["mp4", "webm", "mov", "m4v", "ogv"]
              : ["wav", "mp3", "aac", "m4a", "ogg", "flac"],
      },
    ],
  });
  if (typeof selected !== "string") return undefined;
  const linked = await invoke<{
    relativePath: string;
    resolvedPath: string;
    name: string;
    contentIdentity: string;
    mediaMetadata?: {
      duration: number;
      width?: number;
      height?: number;
      audio?: { streamIndex: number; channels: number; sampleRate: number };
    };
  }>("link_project_asset", {
    bundle: nativeProjectPath,
    source: selected,
    kind: source.kind === "still" ? "image" : source.kind,
  });
  const locator = {
    name: linked.name,
    contentIdentity: linked.contentIdentity,
    dataUrl: undefined,
    relativePath: linked.relativePath,
    runtimeUrl: convertFileSrc(linked.resolvedPath),
  };
  if (source.kind === "audio") {
    const audio = linked.mediaMetadata?.audio;
    if (!audio || !linked.mediaMetadata) throw new Error("Linked audio metadata is unavailable");
    return {
      ...source,
      ...locator,
      duration: linked.mediaMetadata.duration,
      channels: audio.channels,
      sampleRate: audio.sampleRate,
      streamIndex: audio.streamIndex,
    };
  }
  if (source.kind === "video" && linked.mediaMetadata) {
    return {
      ...source,
      ...locator,
      duration: linked.mediaMetadata.duration,
      width: linked.mediaMetadata.width ?? source.width,
      height: linked.mediaMetadata.height ?? source.height,
      audio: linked.mediaMetadata.audio,
    };
  }
  return { ...source, ...locator };
}

export function projectDocumentForPersistence(project: Project): Project {
  return {
    ...project,
    compositions: structuredClone(project.compositions),
    sources: project.sources.map(copySourceWithoutRuntimeUrl),
    ...(project.fonts ? { fonts: project.fonts.map((font) => ({ ...font })) } : {}),
    folders: project.folders.map((folder) => ({ ...folder })),
    itemFolderIds: { ...project.itemFolderIds },
    commandLog: project.commandLog.map((entry) => ({ ...entry })),
  };
}

export async function projectDocumentWithMediaImports(
  project: Project,
  mode: MediaImportPersistenceMode,
): Promise<Project & { mediaImports?: PersistedMediaImports }> {
  const document = projectDocumentForPersistence(project) as Project & {
    mediaImports?: PersistedMediaImports;
  };
  const mediaImports = await createPersistedMediaImports(project, mode);
  if (mediaImports) {
    const represented = new Set(mediaImports.entries.map((entry) => entry.sourceId));
    for (const source of document.sources)
      if (represented.has(source.id)) {
        delete source.dataUrl;
        delete source.runtimeUrl;
      }
    document.mediaImports = mediaImports;
  }
  return document;
}

export async function openPersistedProjectDocument(
  value: unknown,
  allowResolvedMediaPaths = false,
  commit?: { beforeCommit?: () => void; loaded: (project: Project) => void },
): Promise<Project> {
  const { document, mediaImports } = splitPersistedMediaImports(value);
  const project = validateProjectDocument(document);
  await prepareProjectFonts(project);
  await hydratePersistedMediaImports(project, mediaImports, {
    allowResolvedPaths: allowResolvedMediaPaths,
    beforeCommit: commit?.beforeCommit,
    afterCommit: () => commit?.loaded(project),
  });
  return project;
}

function splitPersistedMediaImports(value: unknown): {
  document: unknown;
  mediaImports: unknown;
} {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return { document: value, mediaImports: undefined };
  const { mediaImports, ...document } = value as Record<string, unknown>;
  return { document, mediaImports };
}

function hydrateRuntimeAssetUrls(value: unknown): unknown {
  if (!value || typeof value !== "object") return value;
  const document = value as {
    sources?: Array<Record<string, unknown>>;
    compositions?: Array<{ layers?: Array<{ asset?: Record<string, unknown> }> }>;
  };
  for (const source of document.sources ?? []) {
    const resolvedPath = source.resolvedPath;
    if (typeof resolvedPath !== "string") continue;
    source.runtimeUrl = convertFileSrc(resolvedPath);
    delete source.resolvedPath;
  }
  for (const composition of document.compositions ?? [])
    for (const layer of composition.layers ?? []) {
      const resolvedPath = layer.asset?.resolvedPath;
      if (typeof resolvedPath !== "string" || !layer.asset) continue;
      layer.asset.runtimeUrl = convertFileSrc(resolvedPath);
      delete layer.asset.resolvedPath;
    }
  return value;
}

export function downloadBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function safeFileName(name: string): string {
  const sanitized = Array.from(name.trim(), (character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint < 32 || '<>:"/\\|?*'.includes(character) ? "-" : character;
  }).join("");
  return sanitized || "aster-project";
}

export { validateProjectDocument } from "./validation/document";
