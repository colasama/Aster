import {
  convertFileSrc,
  forgetActiveProject,
  invoke,
  isDesktopRuntime,
  open,
  save,
} from "../desktop/api";
import {
  createPersistedMediaImports,
  hydratePersistedMediaImports,
  type MediaImportPersistenceMode,
  type PersistedMediaImports,
} from "../importers/media-import-persistence";
import { mediaImportRuntime } from "../importers/media-import-runtime";
import { assertAdjustmentLayerInvariants } from "./adjustment-layer";
import {
  MAX_AUDIO_LEVEL_DB,
  MAX_AUDIO_PAN,
  MIN_AUDIO_LEVEL_DB,
  MIN_AUDIO_PAN,
} from "./audio-layer";
import {
  CAMERA_ANIMATABLE_FIELDS,
  CAMERA_PROPERTY_LIMITS,
  type CameraAnimatableField,
} from "./camera-properties";
import { validateClonerSettings } from "./cloner";
import {
  MAX_COMMAND_LOG_ENTRIES,
  MAX_COMMAND_LOG_SIZE,
  MAX_SERIALIZED_COMMAND_SIZE,
} from "./command-log";
import { runCpuTask } from "./cpu-scheduler";
import {
  copySourceWithoutRuntimeUrl,
  MAX_SOURCE_DIMENSION,
  MAX_SOURCE_DURATION,
  sourceSupportsLayer,
} from "./footage-source";
import { logger } from "./logger";
import { prepareProjectFonts } from "./project-font-runtime";
import { validateProjectFonts } from "./project-fonts";
import { assertProjectRenderBoundaries } from "./project-render-boundaries";
import { cloneCurrentProjectDocument } from "./project-schema";
import { assertSceneGeneratorInstance } from "./scene-generator";
import { validateShapeGraph } from "./shape-graph";
import { MAX_SOLID_DIMENSION } from "./solid-layer";
import { MAX_TEXT_SELECTORS_PER_GROUP } from "./text-animator-groups";
import { MAX_TEXT_ANIMATOR_GROUPS } from "./text-animator-stack";
import { normalizeWorkArea } from "./timeline-editing";
import {
  type Composition,
  type Effect,
  type FootageSource,
  isLayerKind,
  type Layer,
  type Project,
} from "./types";

const RECOVERY_KEY = "aster.recoveryProject.v0";
const MAX_EMBEDDED_ASSET_CHARACTERS = 136 * 1024 * 1024;
let nativeProjectPath: string | undefined;
let nativeAutosaveFailureReported = false;
let nativePersistenceQueue: Promise<void> = Promise.resolve();

interface RecoveryStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export function validateProjectDocument(value: unknown): Project {
  const current = cloneCurrentProjectDocument(value);
  const project = requireObject(current, "project");
  if (project.schemaVersion !== 10) throw new Error("Unsupported Aster project schema");
  requireString(project.id, "project.id");
  requireString(project.name, "project.name");
  validateProjectFonts(project.fonts);
  const activeCompositionId = requireString(
    project.activeCompositionId,
    "project.activeCompositionId",
  );
  if (!Array.isArray(project.compositions) || project.compositions.length === 0)
    throw new Error("Project must contain at least one composition");
  if (!Array.isArray(project.sources) || project.sources.length > 50_000)
    throw new Error("project.sources must be a bounded array");
  const sourceById = new Map<string, FootageSource>();
  const sourceIdentities = new Set<string>();
  for (const [index, value] of project.sources.entries()) {
    validateFootageSource(value, `project.sources[${index}]`);
    const source = value as FootageSource;
    if (sourceById.has(source.id)) throw new Error("project.sources contains a duplicate id");
    if (sourceIdentities.has(source.contentIdentity))
      throw new Error("project.sources contains duplicate content identity");
    sourceById.set(source.id, source);
    sourceIdentities.add(source.contentIdentity);
  }
  for (const [index, value] of project.compositions.entries())
    validateComposition(value, `project.compositions[${index}]`);
  for (const composition of project.compositions as unknown as Composition[])
    for (const layer of composition.layers) {
      if (!layer.sourceId) continue;
      const source = sourceById.get(layer.sourceId);
      if (!source) throw new Error(`Layer ${layer.id} references a missing footage source`);
      if (!sourceSupportsLayer(source, layer))
        throw new Error(`Layer ${layer.id} cannot use ${source.kind} footage`);
    }
  project.folders ??= [];
  project.itemFolderIds ??= {};
  validateProjectOrganization(project);
  assertProjectRenderBoundaries(project as unknown as Project);
  if (
    !project.compositions.some(
      (composition) => requireObject(composition, "composition").id === activeCompositionId,
    )
  )
    throw new Error("Active composition does not exist");
  if (typeof project.updatedAt !== "string" || Number.isNaN(Date.parse(project.updatedAt)))
    throw new Error("project.updatedAt must be an ISO date");
  validateCommandLog(project.commandLog);
  return current as unknown as Project;
}

function validateProjectOrganization(project: Record<string, unknown>): void {
  if (!Array.isArray(project.folders) || project.folders.length > 10_000)
    throw new Error("project.folders must be a bounded array");
  const folderIds = new Set<string>();
  const parentIds = new Map<string, string>();
  for (const [index, value] of project.folders.entries()) {
    const folder = requireObject(value, `project.folders[${index}]`);
    const id = requireString(folder.id, `project.folders[${index}].id`);
    const name = requireString(folder.name, `project.folders[${index}].name`);
    if (name.length > 256) throw new Error(`project.folders[${index}].name is too long`);
    if (folderIds.has(id)) throw new Error("project.folders contains a duplicate id");
    folderIds.add(id);
    if (folder.parentId !== undefined)
      parentIds.set(id, requireString(folder.parentId, `project.folders[${index}].parentId`));
  }
  for (const [id, parentId] of parentIds) {
    if (!folderIds.has(parentId)) throw new Error("project folder parent does not exist");
    const visited = new Set([id]);
    let candidate: string | undefined = parentId;
    while (candidate) {
      if (visited.has(candidate)) throw new Error("project folders cannot contain a cycle");
      visited.add(candidate);
      candidate = parentIds.get(candidate);
    }
  }
  const assignments = requireObject(project.itemFolderIds, "project.itemFolderIds");
  if (Object.keys(assignments).length > 50_000)
    throw new Error("project.itemFolderIds must be bounded");
  const itemIds = new Set<string>();
  for (const value of project.compositions as unknown[]) {
    const composition = requireObject(value, "composition");
    itemIds.add(requireString(composition.id, "composition.id"));
  }
  for (const sourceValue of project.sources as unknown[])
    itemIds.add(requireString(requireObject(sourceValue, "source").id, "source.id"));
  for (const [itemId, folderId] of Object.entries(assignments)) {
    if (!itemIds.has(itemId)) throw new Error("project.itemFolderIds references an unknown item");
    if (typeof folderId !== "string" || !folderIds.has(folderId))
      throw new Error("project.itemFolderIds references an unknown folder");
  }
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
): Promise<{ project: Project; name: string }> {
  if (!isDesktopRuntime())
    throw new Error("System project opening requires the desktop application");
  const project = await openPersistedProjectDocument(
    hydrateRuntimeAssetUrls(await invoke("load_project", { path })),
    true,
  );
  nativeProjectPath = path;
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
): Promise<Project> {
  const { document, mediaImports } = splitPersistedMediaImports(value);
  const project = validateProjectDocument(document);
  await prepareProjectFonts(project);
  await hydratePersistedMediaImports(project, mediaImports, {
    allowResolvedPaths: allowResolvedMediaPaths,
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

function validateComposition(value: unknown, path: string): asserts value is Composition {
  const composition = requireObject(value, path);
  requireString(composition.id, `${path}.id`);
  requireString(composition.name, `${path}.name`);
  requirePositiveNumber(composition.width, `${path}.width`);
  requirePositiveNumber(composition.height, `${path}.height`);
  const duration = requirePositiveNumber(composition.duration, `${path}.duration`);
  const frameRate = requireObject(composition.frameRate, `${path}.frameRate`);
  const numerator = requirePositiveNumber(frameRate.numerator, `${path}.frameRate.numerator`);
  const denominator = requirePositiveNumber(frameRate.denominator, `${path}.frameRate.denominator`);
  const workArea = requireObject(composition.workArea, `${path}.workArea`);
  const workAreaStart = requireFiniteNumber(workArea.start, `${path}.workArea.start`);
  const workAreaEnd = requireFiniteNumber(workArea.end, `${path}.workArea.end`);
  const normalizedWorkArea = normalizeWorkArea(
    workAreaStart,
    workAreaEnd,
    duration,
    denominator / numerator,
  );
  if (
    Math.abs(normalizedWorkArea.start - workAreaStart) > 0.000_000_1 ||
    Math.abs(normalizedWorkArea.end - workAreaEnd) > 0.000_000_1
  )
    throw new Error(`${path}.workArea must be a non-empty frame-aligned composition range`);
  if (!Array.isArray(composition.background) || composition.background.length !== 4)
    throw new Error(`${path}.background must contain four channels`);
  const motionBlur = requireObject(composition.motionBlur, `${path}.motionBlur`);
  if (typeof motionBlur.enabled !== "boolean")
    throw new Error(`${path}.motionBlur.enabled must be a boolean`);
  validateBoundedNumber(motionBlur.shutterAngle, `${path}.motionBlur.shutterAngle`, [0, 720]);
  validateBoundedNumber(motionBlur.shutterPhase, `${path}.motionBlur.shutterPhase`, [-720, 720]);
  for (const [field, bounds] of [
    ["samplesPerFrame", [2, 64]],
    ["adaptiveSampleLimit", [2, 128]],
  ] as const) {
    const value = requireFiniteNumber(motionBlur[field], `${path}.motionBlur.${field}`);
    if (!Number.isSafeInteger(value) || value < bounds[0] || value > bounds[1])
      throw new Error(
        `${path}.motionBlur.${field} must be an integer from ${bounds[0]} through ${bounds[1]}`,
      );
  }
  if (Number(motionBlur.adaptiveSampleLimit) < Number(motionBlur.samplesPerFrame))
    throw new Error(`${path}.motionBlur.adaptiveSampleLimit must not be below samplesPerFrame`);
  if (composition.environment !== undefined) {
    const environment = requireObject(composition.environment, `${path}.environment`);
    if (typeof environment.enabled !== "boolean")
      throw new Error(`${path}.environment.enabled must be a boolean`);
    const intensity = requireFiniteNumber(environment.intensity, `${path}.environment.intensity`);
    if (intensity < 0 || intensity > 32)
      throw new Error(`${path}.environment.intensity must be between 0 and 32`);
    const rotation = requireFiniteNumber(environment.rotation, `${path}.environment.rotation`);
    if (Math.abs(rotation) > 1_000_000)
      throw new Error(`${path}.environment.rotation exceeds the supported range`);
    const source = requireObject(environment.source, `${path}.environment.source`);
    const name = requireString(source.name, `${path}.environment.source.name`);
    if (name.length > 512) throw new Error(`${path}.environment.source.name is too long`);
    if (!["image/vnd.radiance", "image/x-hdr"].includes(String(source.mimeType)))
      throw new Error(`${path}.environment.source.mimeType is invalid`);
    const dataUrl = requireString(source.dataUrl, `${path}.environment.source.dataUrl`);
    if (dataUrl.length > 64 * 1024 * 1024)
      throw new Error(`${path}.environment.source.dataUrl exceeds the 64 MiB encoded limit`);
    if (!/^data:image\/(?:vnd\.radiance|x-hdr);base64,/i.test(dataUrl))
      throw new Error(`${path}.environment.source.dataUrl must contain embedded Radiance HDR data`);
  }
  if (!Array.isArray(composition.layers)) throw new Error(`${path}.layers must be an array`);
  const layerIds = new Set<string>();
  for (const [index, layer] of composition.layers.entries()) {
    validateLayer(layer, composition as unknown as Composition, `${path}.layers[${index}]`);
    const id = (layer as Layer).id;
    if (layerIds.has(id)) throw new Error(`${path} contains duplicate layer id ${id}`);
    layerIds.add(id);
  }
}

function validateLayer(
  value: unknown,
  composition: Composition,
  path: string,
): asserts value is Layer {
  const layer = requireObject(value, path);
  requireString(layer.id, `${path}.id`);
  requireString(layer.name, `${path}.name`);
  if (!isLayerKind(layer.kind)) throw new Error(`${path}.kind is unsupported`);
  if (typeof layer.motionBlur !== "boolean")
    throw new Error(`${path}.motionBlur must be a boolean`);
  if (layer.audioEnabled !== undefined && typeof layer.audioEnabled !== "boolean")
    throw new Error(`${path}.audioEnabled must be a boolean`);
  if (layer.audio !== undefined) {
    if (layer.kind !== "audio" && layer.kind !== "video")
      throw new Error(`${path}.audio requires an audio-capable layer`);
    const audio = requireObject(layer.audio, `${path}.audio`);
    const levelsDb = requireNumberArray(audio.levelsDb, `${path}.audio.levelsDb`, 2);
    if (
      levelsDb.length !== 2 ||
      levelsDb.some((level) => level < MIN_AUDIO_LEVEL_DB || level > MAX_AUDIO_LEVEL_DB)
    )
      throw new Error(
        `${path}.audio.levelsDb must contain left/right levels from ${MIN_AUDIO_LEVEL_DB} through ${MAX_AUDIO_LEVEL_DB} dB`,
      );
    const pan = requireFiniteNumber(audio.pan, `${path}.audio.pan`);
    if (pan < MIN_AUDIO_PAN || pan > MAX_AUDIO_PAN)
      throw new Error(`${path}.audio.pan must be between ${MIN_AUDIO_PAN} and ${MAX_AUDIO_PAN}`);
    for (const field of ["muted", "reversed"])
      if (typeof audio[field] !== "boolean")
        throw new Error(`${path}.audio.${field} must be a boolean`);
  }
  if ((layer.kind === "audio" || layer.kind === "video") && layer.audio === undefined)
    throw new Error(`${path}.audio is required for audio-capable layers`);
  if (
    layer.kind === "audio" &&
    (layer.visible !== false ||
      layer.threeDimensional !== false ||
      (Array.isArray(layer.size) && layer.size.some((value) => Number(value) !== 0)))
  )
    throw new Error(`${path} audio layers cannot have a visual surface`);
  if (layer.sourceId !== undefined) requireString(layer.sourceId, `${path}.sourceId`);
  if (layer.solid !== undefined) {
    if (layer.kind !== "solid") throw new Error(`${path}.solid requires solid layer kind`);
    const solid = requireObject(layer.solid, `${path}.solid`);
    for (const field of ["width", "height"] as const) {
      const dimension = requireFiniteNumber(solid[field], `${path}.solid.${field}`);
      if (!Number.isSafeInteger(dimension) || dimension < 1 || dimension > MAX_SOLID_DIMENSION)
        throw new Error(
          `${path}.solid.${field} must be an integer from 1 through ${MAX_SOLID_DIMENSION}`,
        );
    }
    const solidColor = requireNumberArray(solid.color, `${path}.solid.color`, 4);
    if (solidColor.length !== 4 || solidColor.some((channel) => channel < 0 || channel > 1))
      throw new Error(`${path}.solid.color must contain four channels from 0 through 1`);
    if (
      !Array.isArray(layer.size) ||
      layer.size[0] !== solid.width ||
      layer.size[1] !== solid.height
    )
      throw new Error(`${path}.size must mirror the dedicated solid dimensions`);
    if (
      !Array.isArray(layer.color) ||
      layer.color.length !== 4 ||
      layer.color.some((channel, index) => channel !== solidColor[index])
    )
      throw new Error(`${path}.color must mirror the dedicated solid color`);
  }
  if (layer.kind === "solid" && layer.solid === undefined)
    throw new Error(`${path}.solid is required for solid layers`);
  if (layer.text !== undefined && (typeof layer.text !== "string" || layer.text.length > 20_000))
    throw new Error(`${path}.text must be a string at most 20000 characters`);
  requirePositiveNumber(layer.outPoint, `${path}.outPoint`);
  if (layer.timeOffset !== undefined) {
    const offset = requireFiniteNumber(layer.timeOffset, `${path}.timeOffset`);
    if (offset < 0) throw new Error(`${path}.timeOffset must not be negative`);
  }
  if (layer.timeStretch !== undefined)
    requirePositiveNumber(layer.timeStretch, `${path}.timeStretch`);
  if (layer.timeRemap !== undefined) validateAnimatable(layer.timeRemap, `${path}.timeRemap`);
  validateTransform(layer.transform, `${path}.transform`);
  if (layer.material !== undefined) {
    const material = requireObject(layer.material, `${path}.material`);
    for (const field of ["metallic", "roughness", "emissive"])
      requireFiniteNumber(material[field], `${path}.material.${field}`);
    if (!["opaque", "mask", "blend"].includes(String(material.alphaMode)))
      throw new Error(`${path}.material.alphaMode is invalid`);
    const alphaCutoff = requireFiniteNumber(material.alphaCutoff, `${path}.material.alphaCutoff`);
    if (alphaCutoff < 0 || alphaCutoff > 1)
      throw new Error(`${path}.material.alphaCutoff must be between 0 and 1`);
  }
  if (layer.light !== undefined) {
    const light = requireObject(layer.light, `${path}.light`);
    if (!["directional", "point", "spot"].includes(String(light.kind)))
      throw new Error(`${path}.light.kind is invalid`);
    if (!["off", "low", "medium", "high"].includes(String(light.shadowQuality)))
      throw new Error(`${path}.light.shadowQuality is invalid`);
    const intensity = requireFiniteNumber(light.intensity, `${path}.light.intensity`);
    if (intensity < 0) throw new Error(`${path}.light.intensity must not be negative`);
    for (const field of ["range", "coneAngle"])
      requirePositiveNumber(light[field], `${path}.light.${field}`);
  }
  if (layer.camera !== undefined) {
    if (layer.kind !== "camera") throw new Error(`${path}.camera requires camera layer kind`);
    const camera = requireObject(layer.camera, `${path}.camera`);
    if (!["oneNode", "twoNode"].includes(String(camera.mode)))
      throw new Error(`${path}.camera.mode is invalid`);
    if (!["perspective", "orthographic"].includes(String(camera.projection)))
      throw new Error(`${path}.camera.projection is invalid`);
    if ("focalLength" in camera || "fStop" in camera)
      throw new Error(`${path}.camera must not persist derived focal length or f-stop`);
    for (const field of CAMERA_ANIMATABLE_FIELDS)
      validateBoundedCameraProperty(camera[field], `${path}.camera.${field}`, field);
    for (const field of ["pointOfInterest", "orientation"] as const) {
      if (!Array.isArray(camera[field]) || camera[field].length !== 3)
        throw new Error(`${path}.camera.${field} must contain three animated properties`);
      for (const [index, property] of camera[field].entries())
        validateAnimatable(property, `${path}.camera.${field}[${index}]`);
    }
    for (const field of ["depthOfField", "lockFocusToZoom"] as const)
      if (typeof camera[field] !== "boolean")
        throw new Error(`${path}.camera.${field} must be a boolean`);
    if (
      ![
        "fastRectangle",
        "square",
        "triangle",
        "pentagon",
        "hexagon",
        "heptagon",
        "octagon",
        "nonagon",
        "decagon",
        "circle",
      ].includes(String(camera.irisShape))
    )
      throw new Error(`${path}.camera.irisShape is invalid`);
    validateBoundedNumber(camera.renderQuality, `${path}.camera.renderQuality`, [1, 100]);
  }
  if (layer.kind === "camera" && layer.camera === undefined)
    throw new Error(`${path}.camera is required for camera layers`);
  if (layer.mesh !== undefined) {
    const mesh = requireObject(layer.mesh, `${path}.mesh`);
    requireString(mesh.name, `${path}.mesh.name`);
    const positions = requireNumberArray(mesh.positions, `${path}.mesh.positions`, 750_000);
    const normals = requireNumberArray(mesh.normals, `${path}.mesh.normals`, 750_000);
    const uvs = requireNumberArray(mesh.uvs, `${path}.mesh.uvs`, 500_000);
    const indices = requireNumberArray(mesh.indices, `${path}.mesh.indices`, 750_000);
    if (positions.length === 0 || positions.length % 3 !== 0)
      throw new Error(`${path}.mesh.positions must contain 3D vertices`);
    if (normals.length !== positions.length)
      throw new Error(`${path}.mesh.normals must match positions`);
    if (uvs.length !== (positions.length / 3) * 2)
      throw new Error(`${path}.mesh.uvs must match positions`);
    if (indices.length === 0 || indices.length % 3 !== 0)
      throw new Error(`${path}.mesh.indices must contain triangles`);
    if (
      indices.some(
        (index) => !Number.isInteger(index) || index < 0 || index >= positions.length / 3,
      )
    )
      throw new Error(`${path}.mesh.indices reference missing vertices`);
    if (mesh.sourceMaterial !== undefined) {
      const material = requireObject(mesh.sourceMaterial, `${path}.mesh.sourceMaterial`);
      for (const field of ["metallic", "roughness", "emissive", "alphaCutoff"])
        requireFiniteNumber(material[field], `${path}.mesh.sourceMaterial.${field}`);
      if (!["opaque", "mask", "blend"].includes(String(material.alphaMode)))
        throw new Error(`${path}.mesh.sourceMaterial.alphaMode is invalid`);
    }
    if (mesh.baseColor !== undefined) {
      requireNumberArray(mesh.baseColor, `${path}.mesh.baseColor`, 4);
      if ((mesh.baseColor as number[]).length !== 4)
        throw new Error(`${path}.mesh.baseColor must contain four channels`);
    }
    if (mesh.tangents !== undefined) {
      const tangents = requireNumberArray(mesh.tangents, `${path}.mesh.tangents`, 1_000_000);
      if (tangents.length !== (positions.length / 3) * 4)
        throw new Error(`${path}.mesh.tangents must contain xyzw values for every vertex`);
      for (let index = 0; index < tangents.length; index += 4) {
        if (Math.hypot(tangents[index], tangents[index + 1], tangents[index + 2]) < 1e-6)
          throw new Error(`${path}.mesh.tangents tangent xyz must not be near zero`);
        if (tangents[index + 3] !== -1 && tangents[index + 3] !== 1)
          throw new Error(`${path}.mesh.tangents handedness must be -1 or 1`);
      }
    }
    if (mesh.materialTextures !== undefined) {
      const textures = requireObject(mesh.materialTextures, `${path}.mesh.materialTextures`);
      for (const key of ["baseColor", "metallicRoughness", "normal", "emissive"])
        if (textures[key] !== undefined)
          validateMeshTexture(
            textures[key],
            `${path}.mesh.materialTextures.${key}`,
            key === "normal",
          );
    }
  }
  if (layer.generator !== undefined) {
    if (layer.kind !== "generator")
      throw new Error(`${path}.generator requires generator layer kind`);
    assertSceneGeneratorInstance(layer.generator, `${path}.generator`);
  }
  if (layer.kind === "generator" && layer.generator === undefined)
    throw new Error(`${path}.generator is required for generator layers`);
  if (layer.cloner !== undefined) validateClonerSettings(layer.cloner, `${path}.cloner`);
  if (layer.shape !== undefined) {
    const shape = requireObject(layer.shape, `${path}.shape`);
    if (
      shape.kind !== "rectangle" &&
      shape.kind !== "ellipse" &&
      shape.kind !== "line" &&
      shape.kind !== "bezier"
    )
      throw new Error(`${path}.shape.kind is invalid`);
    if (!["solid", "linear", "radial"].includes(String(shape.fillMode)))
      throw new Error(`${path}.shape.fillMode is invalid`);
    if (!["butt", "round"].includes(String(shape.lineCap)))
      throw new Error(`${path}.shape.lineCap is invalid`);
    if (
      shape.lineJoin !== undefined &&
      !["miter", "bevel", "round"].includes(String(shape.lineJoin))
    )
      throw new Error(`${path}.shape.lineJoin is invalid`);
    const roundness = requireFiniteNumber(shape.roundness, `${path}.shape.roundness`);
    const strokeWidth = requireFiniteNumber(shape.strokeWidth, `${path}.shape.strokeWidth`);
    const dashLength = requireFiniteNumber(shape.dashLength, `${path}.shape.dashLength`);
    const dashGap = requireFiniteNumber(shape.dashGap, `${path}.shape.dashGap`);
    requireFiniteNumber(shape.gradientAngle, `${path}.shape.gradientAngle`);
    if (shape.trim !== undefined) {
      const trim = requireObject(shape.trim, `${path}.shape.trim`);
      const start = requireFiniteNumber(trim.start, `${path}.shape.trim.start`);
      const end = requireFiniteNumber(trim.end, `${path}.shape.trim.end`);
      const offset = requireFiniteNumber(trim.offset, `${path}.shape.trim.offset`);
      if (start < 0 || start > 100 || end < 0 || end > 100)
        throw new Error(`${path}.shape.trim start and end must be percentages from 0 through 100`);
      if (Math.abs(offset) > 100_000)
        throw new Error(`${path}.shape.trim.offset exceeds the supported range`);
    }
    if (roundness < 0 || strokeWidth < 0 || dashLength < 0 || dashGap < 0)
      throw new Error(`${path}.shape dimensions must not be negative`);
    requireNumberArray(shape.strokeColor, `${path}.shape.strokeColor`, 4);
    if ((shape.strokeColor as number[]).length !== 4)
      throw new Error(`${path}.shape.strokeColor must contain four channels`);
    requireNumberArray(shape.gradientColor, `${path}.shape.gradientColor`, 4);
    if ((shape.gradientColor as number[]).length !== 4)
      throw new Error(`${path}.shape.gradientColor must contain four channels`);
    if (shape.kind === "bezier") validateBezierPath(shape.path, `${path}.shape.path`);
  }
  if (layer.shapeGraph !== undefined) validateShapeGraph(layer.shapeGraph, `${path}.shapeGraph`);
  if (layer.textStyle !== undefined) {
    const style = requireObject(layer.textStyle, `${path}.textStyle`);
    if (requireString(style.fontFamily, `${path}.textStyle.fontFamily`).length > 160)
      throw new Error(`${path}.textStyle.fontFamily is too long`);
    for (const field of ["fontSize", "fontWeight", "leading"])
      requirePositiveNumber(style[field], `${path}.textStyle.${field}`);
    for (const field of ["tracking", "strokeWidth"])
      requireFiniteNumber(style[field], `${path}.textStyle.${field}`);
    if ((style.strokeWidth as number) < 0)
      throw new Error(`${path}.textStyle.strokeWidth must not be negative`);
    const fontWeight = style.fontWeight as number;
    if (fontWeight < 100 || fontWeight > 900)
      throw new Error(`${path}.textStyle.fontWeight must be between 100 and 900`);
    if (!["left", "center", "right"].includes(String(style.alignment)))
      throw new Error(`${path}.textStyle.alignment is invalid`);
    const strokeColor = requireNumberArray(style.strokeColor, `${path}.textStyle.strokeColor`, 4);
    if (strokeColor.length !== 4)
      throw new Error(`${path}.textStyle.strokeColor must contain four channels`);
  }
  if (layer.textAnimator !== undefined)
    validateTextAnimator(layer.textAnimator, `${path}.textAnimator`);
  if (!Array.isArray(layer.size) || layer.size.length !== 2)
    throw new Error(`${path}.size must contain two values`);
  if (!Array.isArray(layer.color) || layer.color.length !== 4)
    throw new Error(`${path}.color must contain four channels`);
  requireObject(layer.transform, `${path}.transform`);
  if (!Array.isArray(layer.effects)) throw new Error(`${path}.effects must be an array`);
  for (const [index, effect] of layer.effects.entries())
    validateEffect(effect, `${path}.effects[${index}]`);
  const reusablePathIds = new Set(
    ((layer.shapeGraph as { paths?: Array<{ id?: unknown }> } | undefined)?.paths ?? []).map(
      (resource) => resource.id,
    ),
  );
  for (const [index, effect] of (layer.effects as Effect[]).entries()) {
    if (effect.mask?.shape !== "path") continue;
    if (!effect.mask.pathId || !reusablePathIds.has(effect.mask.pathId))
      throw new Error(`${path}.effects[${index}].mask references a missing shape path`);
  }
  assertAdjustmentLayerInvariants(layer as unknown as Layer, composition, path);
}

function validateMeshTexture(value: unknown, path: string, normal: boolean): void {
  const texture = requireObject(value, path);
  if (!["image/jpeg", "image/png", "image/webp"].includes(String(texture.mimeType)))
    throw new Error(`${path}.mimeType is invalid`);
  if (texture.texCoord !== 0) throw new Error(`${path}.texCoord must be 0`);
  const dataUrl = requireString(texture.dataUrl, `${path}.dataUrl`);
  if (dataUrl.length > 64 * 1024 * 1024)
    throw new Error(`${path}.dataUrl exceeds the 64 MiB encoded limit`);
  if (!/^data:image\/(?:jpeg|png|webp);base64,/i.test(dataUrl))
    throw new Error(`${path}.dataUrl must contain an embedded supported image`);
  if (texture.scale !== undefined) {
    if (!normal) throw new Error(`${path}.scale is only valid for a normal map`);
    const scale = requireFiniteNumber(texture.scale, `${path}.scale`);
    if (scale < -8 || scale > 8) throw new Error(`${path}.scale must be between -8 and 8`);
  }
}

function validateTextAnimator(value: unknown, path: string): void {
  const animator = requireObject(value, path);
  if (typeof animator.enabled !== "boolean") throw new Error(`${path}.enabled must be a boolean`);
  if (!Array.isArray(animator.groups) || animator.groups.length > MAX_TEXT_ANIMATOR_GROUPS)
    throw new Error(`${path}.groups must be a bounded array`);
  const groupIds = new Set<string>();
  for (const [groupIndex, groupValue] of animator.groups.entries()) {
    const groupPath = `${path}.groups[${groupIndex}]`;
    const group = requireObject(groupValue, groupPath);
    validateUniqueBoundedId(group.id, `${groupPath}.id`, groupIds);
    const name = requireString(group.name, `${groupPath}.name`);
    if (!name.trim() || name.length > 128) throw new Error(`${groupPath}.name is invalid`);
    if (typeof group.enabled !== "boolean")
      throw new Error(`${groupPath}.enabled must be a boolean`);
    validateInteger(group.randomSeed, `${groupPath}.randomSeed`, [-2_147_483_648, 2_147_483_647]);
    validateTextAnimatorProperties(group.properties, `${groupPath}.properties`);
    if (!Array.isArray(group.selectors) || group.selectors.length > MAX_TEXT_SELECTORS_PER_GROUP)
      throw new Error(`${groupPath}.selectors must be a bounded array`);
    const selectorIds = new Set<string>();
    for (const [selectorIndex, selectorValue] of group.selectors.entries())
      validateTextSelector(selectorValue, `${groupPath}.selectors[${selectorIndex}]`, selectorIds);
  }
}

function validateTextSelector(value: unknown, path: string, ids: Set<string>): void {
  const selector = requireObject(value, path);
  validateUniqueBoundedId(selector.id, `${path}.id`, ids);
  const name = requireString(selector.name, `${path}.name`);
  if (!name.trim() || name.length > 128) throw new Error(`${path}.name is invalid`);
  if (typeof selector.enabled !== "boolean") throw new Error(`${path}.enabled must be a boolean`);
  if (!["add", "subtract", "intersect", "min", "max", "difference"].includes(String(selector.mode)))
    throw new Error(`${path}.mode is unsupported`);
  if (
    !["characters", "charactersExcludingSpaces", "words", "lines"].includes(
      String(selector.basedOn),
    )
  )
    throw new Error(`${path}.basedOn is unsupported`);
  validateBoundedAnimatable(selector.amount, `${path}.amount`, [-100, 100]);
  if (selector.kind === "range") {
    if (!["percentage", "index"].includes(String(selector.units)))
      throw new Error(`${path}.units is unsupported`);
    if (
      !["square", "rampUp", "rampDown", "triangle", "round", "smooth"].includes(
        String(selector.shape),
      )
    )
      throw new Error(`${path}.shape is unsupported`);
    for (const field of ["start", "end", "offset"] as const)
      validateBoundedAnimatable(selector[field], `${path}.${field}`, [-1_000_000, 1_000_000]);
    validateBoundedAnimatable(selector.smoothness, `${path}.smoothness`, [0, 100]);
    validateBoundedAnimatable(selector.easeHigh, `${path}.easeHigh`, [-100, 100]);
    validateBoundedAnimatable(selector.easeLow, `${path}.easeLow`, [-100, 100]);
    if (typeof selector.randomizeOrder !== "boolean")
      throw new Error(`${path}.randomizeOrder must be a boolean`);
    validateInteger(selector.randomSeed, `${path}.randomSeed`, [-2_147_483_648, 2_147_483_647]);
    return;
  }
  if (selector.kind === "wiggly") {
    validateBoundedAnimatable(selector.minimumAmount, `${path}.minimumAmount`, [-100, 100]);
    validateBoundedAnimatable(selector.maximumAmount, `${path}.maximumAmount`, [-100, 100]);
    validateBoundedAnimatable(selector.wigglesPerSecond, `${path}.wigglesPerSecond`, [0, 100]);
    validateBoundedAnimatable(selector.correlation, `${path}.correlation`, [0, 100]);
    validateBoundedAnimatable(
      selector.temporalPhase,
      `${path}.temporalPhase`,
      [-1_000_000, 1_000_000],
    );
    validateBoundedAnimatable(
      selector.spatialPhase,
      `${path}.spatialPhase`,
      [-1_000_000, 1_000_000],
    );
    validateInteger(selector.randomSeed, `${path}.randomSeed`, [-2_147_483_648, 2_147_483_647]);
    return;
  }
  if (selector.kind !== "expression") throw new Error(`${path}.kind is unsupported`);
  const expression = requireString(selector.expression, `${path}.expression`);
  if (!expression.trim() || expression.length > 2_048)
    throw new Error(`${path}.expression must contain at most 2048 characters`);
}

function validateTextAnimatorProperties(value: unknown, path: string): void {
  const properties = requireObject(value, path);
  for (const [field, length, bounds] of [
    ["anchorPoint", 3, [-8192, 8192]],
    ["position", 3, [-8192, 8192]],
    ["scale", 3, [-10_000, 10_000]],
    ["rotation", 3, [-36_000, 36_000]],
    ["fillColor", 4, [0, 1]],
    ["strokeColor", 4, [0, 1]],
    ["lineSpacing", 2, [-8192, 8192]],
    ["blur", 2, [0, 4096]],
  ] as const) {
    if (properties[field] === undefined) continue;
    const vector = properties[field];
    if (!Array.isArray(vector) || vector.length !== length)
      throw new Error(`${path}.${field} must contain ${length} animated values`);
    for (const [index, property] of vector.entries())
      validateBoundedAnimatable(property, `${path}.${field}[${index}]`, bounds);
  }
  for (const [field, bounds] of [
    ["skew", [-360, 360]],
    ["skewAxis", [-360, 360]],
    ["opacity", [0, 100]],
    ["strokeWidth", [-4096, 4096]],
    ["tracking", [-10_000, 10_000]],
    ["lineAnchor", [0, 100]],
    ["characterOffset", [-0x10ffff, 0x10ffff]],
    ["characterValue", [0, 0x10ffff]],
  ] as const)
    if (properties[field] !== undefined)
      validateBoundedAnimatable(properties[field], `${path}.${field}`, bounds);
  const hasCharacterReplacement =
    properties.characterOffset !== undefined || properties.characterValue !== undefined;
  if (hasCharacterReplacement) {
    if (!["preserveCaseAndDigits", "fullUnicode"].includes(String(properties.characterRange)))
      throw new Error(`${path}.characterRange is unsupported`);
  } else if (properties.characterRange !== undefined) {
    throw new Error(`${path}.characterRange requires Character Offset or Character Value`);
  }
}

function validateUniqueBoundedId(value: unknown, path: string, ids: Set<string>): void {
  const id = requireString(value, path);
  if (!id || id.length > 256 || ids.has(id)) throw new Error(`${path} must be unique and bounded`);
  ids.add(id);
}

function validateInteger(value: unknown, path: string, bounds: readonly [number, number]): void {
  const number = requireFiniteNumber(value, path);
  if (!Number.isSafeInteger(number) || number < bounds[0] || number > bounds[1])
    throw new Error(`${path} must be an integer from ${bounds[0]} through ${bounds[1]}`);
}

function validateBoundedAnimatable(
  value: unknown,
  path: string,
  bounds: readonly [number, number],
): void {
  validateAnimatable(value, path);
  const property = value as
    | { mode: "static"; value: number }
    | { mode: "animated"; keyframes: Array<{ value: number }> };
  const values =
    property.mode === "static"
      ? [property.value]
      : property.keyframes.map((keyframe) => keyframe.value);
  if (values.some((number) => number < bounds[0] || number > bounds[1]))
    throw new Error(`${path} values must be between ${bounds[0]} and ${bounds[1]}`);
}

function validateBoundedNumber(
  value: unknown,
  path: string,
  bounds: readonly [number, number],
): void {
  const number = requireFiniteNumber(value, path);
  if (number < bounds[0] || number > bounds[1])
    throw new Error(`${path} must be between ${bounds[0]} and ${bounds[1]}`);
}

function validateFootageSource(value: unknown, path: string): asserts value is FootageSource {
  const source = requireObject(value, path);
  if (requireString(source.id, `${path}.id`).length > 256)
    throw new Error(`${path}.id is too long`);
  const name = requireString(source.name, `${path}.name`);
  if (!name.trim() || name.length > 512) throw new Error(`${path}.name is too long`);
  if (requireString(source.mimeType, `${path}.mimeType`).length > 256)
    throw new Error(`${path}.mimeType is too long`);
  if (requireString(source.contentIdentity, `${path}.contentIdentity`).length > 256)
    throw new Error(`${path}.contentIdentity is too long`);
  if (!["still", "video", "audio", "imageSequence", "svg", "psd"].includes(String(source.kind)))
    throw new Error(`${path}.kind is unsupported`);
  if (["still", "video", "imageSequence", "svg", "psd"].includes(String(source.kind))) {
    for (const field of ["width", "height"] as const) {
      const dimension = requireFiniteNumber(source[field], `${path}.${field}`);
      if (!Number.isSafeInteger(dimension) || dimension < 1 || dimension > MAX_SOURCE_DIMENSION)
        throw new Error(
          `${path}.${field} must be an integer from 1 through ${MAX_SOURCE_DIMENSION}`,
        );
    }
  }
  if (source.kind === "video" || source.kind === "audio") {
    const duration = requirePositiveNumber(source.duration, `${path}.duration`);
    if (duration > MAX_SOURCE_DURATION)
      throw new Error(`${path}.duration exceeds the supported range`);
  }
  if (source.kind === "audio") {
    const channels = requireFiniteNumber(source.channels, `${path}.channels`);
    const sampleRate = requireFiniteNumber(source.sampleRate, `${path}.sampleRate`);
    if (!Number.isSafeInteger(channels) || channels < 1 || channels > 32)
      throw new Error(`${path}.channels must be an integer from 1 through 32`);
    if (!Number.isSafeInteger(sampleRate) || sampleRate < 8_000 || sampleRate > 384_000)
      throw new Error(`${path}.sampleRate is unsupported`);
    const streamIndex = requireFiniteNumber(source.streamIndex, `${path}.streamIndex`);
    if (!Number.isSafeInteger(streamIndex) || streamIndex < 0 || streamIndex >= 128)
      throw new Error(`${path}.streamIndex is unsupported`);
  }
  if (source.kind === "video" && source.audio !== undefined) {
    const audio = requireObject(source.audio, `${path}.audio`);
    for (const field of ["streamIndex", "channels", "sampleRate"] as const) {
      const value = requireFiniteNumber(audio[field], `${path}.audio.${field}`);
      if (!Number.isSafeInteger(value))
        throw new Error(`${path}.audio.${field} must be an integer`);
    }
    if ((audio.streamIndex as number) < 0 || (audio.streamIndex as number) >= 128)
      throw new Error(`${path}.audio.streamIndex is unsupported`);
    if ((audio.channels as number) < 1 || (audio.channels as number) > 32)
      throw new Error(`${path}.audio.channels is unsupported`);
    if ((audio.sampleRate as number) < 8_000 || (audio.sampleRate as number) > 384_000)
      throw new Error(`${path}.audio.sampleRate is unsupported`);
  }
  if (source.kind === "imageSequence") {
    if (requireString(source.pattern, `${path}.pattern`).trim().length === 0)
      throw new Error(`${path}.pattern must not be blank`);
    if (String(source.pattern).length > 1024) throw new Error(`${path}.pattern is too long`);
    const startFrame = requireFiniteNumber(source.startFrame, `${path}.startFrame`);
    const endFrame = requireFiniteNumber(source.endFrame, `${path}.endFrame`);
    if (
      !Number.isSafeInteger(startFrame) ||
      !Number.isSafeInteger(endFrame) ||
      endFrame < startFrame
    )
      throw new Error(`${path} has an invalid frame range`);
  }
  if (source.kind === "psd") {
    const layerCount = requireFiniteNumber(source.layerCount, `${path}.layerCount`);
    if (!Number.isSafeInteger(layerCount) || layerCount < 1 || layerCount > 10_000)
      throw new Error(`${path}.layerCount must be an integer from 1 through 10000`);
  }
  const interpretation = requireObject(source.interpretation, `${path}.interpretation`);
  if (!["straight", "premultiplied", "ignore"].includes(String(interpretation.alpha)))
    throw new Error(`${path}.interpretation.alpha is unsupported`);
  if (!["srgb", "linear", "display-p3"].includes(String(interpretation.colorSpace)))
    throw new Error(`${path}.interpretation.colorSpace is unsupported`);
  if (interpretation.frameRate !== undefined) {
    const frameRate = requireObject(interpretation.frameRate, `${path}.interpretation.frameRate`);
    for (const field of ["numerator", "denominator"] as const) {
      const rate = requirePositiveNumber(
        frameRate[field],
        `${path}.interpretation.frameRate.${field}`,
      );
      if (!Number.isSafeInteger(rate) || rate > 240_000)
        throw new Error(`${path}.interpretation.frameRate.${field} is unsupported`);
    }
  }
  if (source.relativePath !== undefined) {
    const relativePath = requireString(source.relativePath, `${path}.relativePath`);
    if (
      relativePath.length > 1024 ||
      relativePath.includes("\\") ||
      relativePath.split("/").some((segment) => segment === "..") ||
      relativePath.startsWith("/")
    )
      throw new Error(`${path}.relativePath must stay inside the project bundle`);
  }
  if (
    source.runtimeUrl !== undefined &&
    requireString(source.runtimeUrl, `${path}.runtimeUrl`).length > 4096
  )
    throw new Error(`${path}.runtimeUrl is too long`);
  if (source.dataUrl === undefined) return;
  const dataUrl = requireString(source.dataUrl, `${path}.dataUrl`);
  if (!dataUrl.startsWith("data:") || dataUrl.length > MAX_EMBEDDED_ASSET_CHARACTERS)
    throw new Error(`${path}.dataUrl must be a bounded embedded data URL`);
}

function validateTransform(value: unknown, path: string): void {
  const transform = requireObject(value, path);
  for (const field of ["position", "rotation", "scale", "anchor"] as const) {
    if (!Array.isArray(transform[field]) || transform[field].length !== 3)
      throw new Error(`${path}.${field} must contain three animated properties`);
    for (const [index, property] of transform[field].entries())
      validateAnimatable(property, `${path}.${field}[${index}]`);
  }
  validateAnimatable(transform.opacity, `${path}.opacity`);
}

function validateBezierPath(value: unknown, path: string): void {
  const bezier = requireObject(value, path);
  if (typeof bezier.closed !== "boolean") throw new Error(`${path}.closed must be a boolean`);
  if (!Array.isArray(bezier.vertices) || bezier.vertices.length < 2 || bezier.vertices.length > 512)
    throw new Error(`${path}.vertices must contain between 2 and 512 anchors`);
  for (const [index, value] of bezier.vertices.entries()) {
    const vertex = requireObject(value, `${path}.vertices[${index}]`);
    for (const field of ["position", "inTangent", "outTangent"] as const) {
      const point = requireNumberArray(vertex[field], `${path}.vertices[${index}].${field}`, 2);
      if (point.length !== 2 || point.some((channel) => Math.abs(channel) > 16))
        throw new Error(`${path}.vertices[${index}].${field} is out of range`);
    }
  }
}

function validateAnimatable(value: unknown, path: string): void {
  const property = requireObject(value, path);
  if (property.mode === "static") {
    requireFiniteNumber(property.value, `${path}.value`);
    return;
  }
  if (property.mode !== "animated" || !Array.isArray(property.keyframes))
    throw new Error(`${path} must be a static or animated property`);
  if (property.keyframes.length > 10_000) throw new Error(`${path}.keyframes must be bounded`);
  let previousTime = -Infinity;
  const ids = new Set<string>();
  for (const [index, value] of property.keyframes.entries()) {
    const keyframe = requireObject(value, `${path}.keyframes[${index}]`);
    const id = requireString(keyframe.id, `${path}.keyframes[${index}].id`);
    if (ids.has(id)) throw new Error(`${path}.keyframes contains duplicate id ${id}`);
    ids.add(id);
    const time = requireFiniteNumber(keyframe.time, `${path}.keyframes[${index}].time`);
    requireFiniteNumber(keyframe.value, `${path}.keyframes[${index}].value`);
    if (time < 0 || time <= previousTime) throw new Error(`${path}.keyframes must be sorted`);
    if (!["linear", "step", "bezier"].includes(String(keyframe.interpolation)))
      throw new Error(`${path}.keyframes has invalid interpolation`);
    validateKeyframeHandles(keyframe, `${path}.keyframes[${index}]`);
    previousTime = time;
  }
}

function validateBoundedCameraProperty(
  value: unknown,
  path: string,
  field: CameraAnimatableField,
): void {
  validateAnimatable(value, path);
  const property = value as {
    mode: "static" | "animated";
    value?: number;
    keyframes?: Array<{ value: number }>;
  };
  const limit = CAMERA_PROPERTY_LIMITS[field];
  const values =
    property.mode === "static"
      ? [property.value]
      : (property.keyframes ?? []).map((keyframe) => keyframe.value);
  for (const [index, entry] of values.entries()) {
    const valuePath =
      property.mode === "static" ? `${path}.value` : `${path}.keyframes[${index}].value`;
    validateBoundedNumber(entry, valuePath, [limit.minimum, limit.maximum]);
  }
}

function validateKeyframeHandles(keyframe: Record<string, unknown>, path: string): void {
  if (
    keyframe.easing !== undefined &&
    (!Array.isArray(keyframe.easing) ||
      keyframe.easing.length !== 4 ||
      keyframe.easing.some((channel) => typeof channel !== "number" || !Number.isFinite(channel)))
  )
    throw new Error(`${path}.easing must contain four finite values`);
  for (const field of ["spatialIn", "spatialOut"] as const)
    if (
      keyframe[field] !== undefined &&
      (typeof keyframe[field] !== "number" || !Number.isFinite(keyframe[field]))
    )
      throw new Error(`${path}.${field} must be finite`);
}

function validateEffect(value: unknown, path: string): void {
  const effect = requireObject(value, path);
  requireString(effect.id, `${path}.id`);
  requireString(effect.type, `${path}.type`);
  requireString(effect.name, `${path}.name`);
  if (typeof effect.enabled !== "boolean") throw new Error(`${path}.enabled must be a boolean`);
  const parameters = requireObject(effect.parameters, `${path}.parameters`);
  for (const [key, parameter] of Object.entries(parameters))
    if (typeof parameter !== "number" || !Number.isFinite(parameter))
      throw new Error(`${path}.parameters.${key} must be finite`);
  if (effect.parameterKeyframes !== undefined) {
    const tracks = requireObject(effect.parameterKeyframes, `${path}.parameterKeyframes`);
    for (const [parameter, value] of Object.entries(tracks)) {
      if (!Array.isArray(value) || value.length > 10_000)
        throw new Error(`${path}.parameterKeyframes.${parameter} must be a bounded array`);
      let previousTime = -Infinity;
      const keyframeIds = new Set<string>();
      for (const [index, keyframeValue] of value.entries()) {
        const keyframe = requireObject(
          keyframeValue,
          `${path}.parameterKeyframes.${parameter}[${index}]`,
        );
        const id = requireString(
          keyframe.id,
          `${path}.parameterKeyframes.${parameter}[${index}].id`,
        );
        if (keyframeIds.has(id))
          throw new Error(`${path}.parameterKeyframes.${parameter} contains a duplicate id`);
        keyframeIds.add(id);
        const time = requireFiniteNumber(
          keyframe.time,
          `${path}.parameterKeyframes.${parameter}[${index}].time`,
        );
        requireFiniteNumber(
          keyframe.value,
          `${path}.parameterKeyframes.${parameter}[${index}].value`,
        );
        if (time < 0 || time <= previousTime)
          throw new Error(`${path}.parameterKeyframes.${parameter} must be strictly sorted`);
        if (!["linear", "step", "bezier"].includes(String(keyframe.interpolation)))
          throw new Error(`${path}.parameterKeyframes.${parameter} has invalid interpolation`);
        if (
          keyframe.easing !== undefined &&
          (!Array.isArray(keyframe.easing) ||
            keyframe.easing.length !== 4 ||
            keyframe.easing.some(
              (channel) => typeof channel !== "number" || !Number.isFinite(channel),
            ))
        )
          throw new Error(`${path}.parameterKeyframes.${parameter} has invalid easing`);
        validateKeyframeHandles(keyframe, `${path}.parameterKeyframes.${parameter}[${index}]`);
        previousTime = time;
      }
    }
  }
  if (effect.mask !== undefined) validateEffectMask(effect.mask, `${path}.mask`);
  if (effect.resource !== undefined) validateLutResource(effect.resource, `${path}.resource`);
}

function validateEffectMask(value: unknown, path: string): void {
  const mask = requireObject(value, path);
  if (mask.shape !== "ellipse" && mask.shape !== "rectangle" && mask.shape !== "path")
    throw new Error(`${path}.shape must be ellipse, rectangle, or path`);
  if (mask.shape === "path") requireString(mask.pathId, `${path}.pathId`);
  else if (mask.pathId !== undefined)
    throw new Error(`${path}.pathId is only valid for path masks`);
  if (!Array.isArray(mask.center) || mask.center.length !== 2)
    throw new Error(`${path}.center must contain two values`);
  if (!Array.isArray(mask.size) || mask.size.length !== 2)
    throw new Error(`${path}.size must contain two values`);
  for (const [index, channel] of mask.center.entries()) {
    const value = requireFiniteNumber(channel, `${path}.center[${index}]`);
    if (value < -1000 || value > 1000) throw new Error(`${path}.center is out of range`);
  }
  for (const [index, channel] of mask.size.entries()) {
    const value = requirePositiveNumber(channel, `${path}.size[${index}]`);
    if (value > 2000) throw new Error(`${path}.size is out of range`);
  }
  const feather = requireFiniteNumber(mask.feather, `${path}.feather`);
  if (feather < 0 || feather > 8000) throw new Error(`${path}.feather is out of range`);
  const opacity = requireFiniteNumber(mask.opacity, `${path}.opacity`);
  if (opacity < 0 || opacity > 100) throw new Error(`${path}.opacity is out of range`);
  if (typeof mask.invert !== "boolean") throw new Error(`${path}.invert must be a boolean`);
}

function validateLutResource(value: unknown, path: string): void {
  const resource = requireObject(value, path);
  if (resource.kind !== "lut3d") throw new Error(`${path}.kind must be lut3d`);
  if (requireString(resource.name, `${path}.name`).length > 160)
    throw new Error(`${path}.name is too long`);
  if (!/^[a-f0-9]{8}$/.test(requireString(resource.checksum, `${path}.checksum`)))
    throw new Error(`${path}.checksum is invalid`);
  const size = requirePositiveNumber(resource.size, `${path}.size`);
  if (!Number.isInteger(size) || size > 64)
    throw new Error(`${path}.size must be an integer at most 64`);
  if (!Array.isArray(resource.data) || resource.data.length !== size ** 3 * 3)
    throw new Error(`${path}.data has an invalid length`);
  if (
    resource.data.some(
      (channel) =>
        typeof channel !== "number" || !Number.isFinite(channel) || Math.abs(channel) > 64,
    )
  )
    throw new Error(`${path}.data must contain bounded finite channels`);
  for (const field of ["domainMin", "domainMax"] as const) {
    if (!Array.isArray(resource[field]) || resource[field].length !== 3)
      throw new Error(`${path}.${field} must contain three channels`);
    if (
      resource[field].some(
        (channel) =>
          typeof channel !== "number" || !Number.isFinite(channel) || Math.abs(channel) > 64,
      )
    )
      throw new Error(`${path}.${field} must contain bounded finite channels`);
  }
  for (let channel = 0; channel < 3; channel += 1)
    if ((resource.domainMax as number[])[channel] <= (resource.domainMin as number[])[channel])
      throw new Error(`${path} has an invalid domain`);
}

function validateCommandLog(value: unknown): void {
  if (!Array.isArray(value) || value.length > MAX_COMMAND_LOG_ENTRIES)
    throw new Error(`project.commandLog must contain at most ${MAX_COMMAND_LOG_ENTRIES} entries`);
  if (JSON.stringify(value).length > MAX_COMMAND_LOG_SIZE)
    throw new Error("project.commandLog exceeds its serialized size budget");
  const ids = new Set<string>();
  for (const [index, candidate] of value.entries()) {
    const path = `project.commandLog[${index}]`;
    const entry = requireObject(candidate, path);
    const id = requireString(entry.id, `${path}.id`);
    if (ids.has(id)) throw new Error("project.commandLog contains a duplicate id");
    ids.add(id);
    const at = requireString(entry.at, `${path}.at`);
    if (Number.isNaN(Date.parse(at))) throw new Error(`${path}.at must be an ISO date`);
    if (entry.source !== "ai" && entry.source !== "user")
      throw new Error(`${path}.source is invalid`);
    if (requireString(entry.summary, `${path}.summary`).length > 500)
      throw new Error(`${path}.summary is too long`);
    if (!Array.isArray(entry.operationTypes) || entry.operationTypes.length > 100)
      throw new Error(`${path}.operationTypes must be a bounded array`);
    const types = entry.operationTypes.map((type, typeIndex) =>
      requireString(type, `${path}.operationTypes[${typeIndex}]`),
    );
    if (entry.serializedOperations === undefined) continue;
    const serialized = requireString(entry.serializedOperations, `${path}.serializedOperations`);
    if (serialized.length > MAX_SERIALIZED_COMMAND_SIZE)
      throw new Error(`${path}.serializedOperations is too large`);
    let operations: unknown;
    try {
      operations = JSON.parse(serialized);
    } catch {
      throw new Error(`${path}.serializedOperations is not valid JSON`);
    }
    if (
      !Array.isArray(operations) ||
      operations.length !== types.length ||
      operations.some(
        (operation, operationIndex) =>
          !operation ||
          typeof operation !== "object" ||
          (operation as { type?: unknown }).type !== types[operationIndex],
      )
    )
      throw new Error(`${path}.serializedOperations does not match its operation manifest`);
  }
}

function requireObject(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`${path} must be an object`);
  return value as Record<string, unknown>;
}

function requireString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${path} must be a string`);
  return value;
}

function requirePositiveNumber(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0)
    throw new Error(`${path} must be a positive number`);
  return value;
}

function requireFiniteNumber(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value))
    throw new Error(`${path} must be a finite number`);
  return value;
}

function requireNumberArray(value: unknown, path: string, maximumLength: number): number[] {
  if (!Array.isArray(value) || value.length > maximumLength)
    throw new Error(`${path} must be a bounded number array`);
  if (value.some((entry) => typeof entry !== "number" || !Number.isFinite(entry)))
    throw new Error(`${path} must contain finite numbers`);
  return value as number[];
}

function safeFileName(name: string): string {
  const sanitized = Array.from(name.trim(), (character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint < 32 || '<>:"/\\|?*'.includes(character) ? "-" : character;
  }).join("");
  return sanitized || "aster-project";
}
