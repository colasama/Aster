import {
  convertFileSrc,
  forgetActiveProject,
  invoke,
  isDesktopRuntime,
  open,
  save,
} from "../desktop/api";
import { assertAdjustmentLayerInvariants } from "./adjustment-layer";
import { validateClonerSettings } from "./cloner";
import {
  MAX_COMMAND_LOG_ENTRIES,
  MAX_COMMAND_LOG_SIZE,
  MAX_SERIALIZED_COMMAND_SIZE,
} from "./command-log";
import { runCpuTask } from "./cpu-scheduler";
import { logger } from "./logger";
import { assertParticleSettings } from "./particle-settings";
import { assertProjectRenderBoundaries } from "./project-render-boundaries";
import { cloneCurrentProjectDocument } from "./project-schema";
import { validateShapeGraph } from "./shape-graph";
import { TEXT_ANIMATOR_LIMITS } from "./text-animator";
import { normalizeWorkArea } from "./timeline-editing";
import { type Composition, type Effect, isLayerKind, type Layer, type Project } from "./types";

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
  if (project.schemaVersion !== 1) throw new Error("Unsupported Aster project schema");
  requireString(project.id, "project.id");
  requireString(project.name, "project.name");
  const activeCompositionId = requireString(
    project.activeCompositionId,
    "project.activeCompositionId",
  );
  if (!Array.isArray(project.compositions) || project.compositions.length === 0)
    throw new Error("Project must contain at least one composition");
  for (const [index, value] of project.compositions.entries())
    validateComposition(value, `project.compositions[${index}]`);
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
    for (const layerValue of composition.layers as unknown[]) {
      const layer = requireObject(layerValue, "layer");
      if (layer.asset !== undefined) itemIds.add(requireString(layer.id, "layer.id"));
    }
  }
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
  const serialized = await runCpuTask(
    {
      kind: "serialize-json",
      maxOutputCharacters: MAX_EMBEDDED_ASSET_CHARACTERS + 16 * 1024 * 1024,
      spacing: 2,
      trailingNewline: true,
      value: projectDocumentForPersistence(project),
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
  if (chooseDirectory || !nativeProjectPath) {
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
    await queueNativePersistence(async () => {
      await invoke("save_project", {
        path: destination,
        project: projectDocumentForPersistence(project),
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
    const project = validateProjectDocument(
      hydrateRuntimeAssetUrls(await invoke("load_project", { path: selected })),
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
          const project = validateProjectDocument(JSON.parse(await file.text()));
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
  const project = validateProjectDocument(
    hydrateRuntimeAssetUrls(await invoke("load_project", { path })),
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
  const project = validateProjectDocument(
    hydrateRuntimeAssetUrls(await invoke("load_project", { path: destination })),
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
      await queueNativePersistence(() =>
        invoke("save_autosave", {
          path: autosavePath,
          project: projectDocumentForPersistence(project),
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
    storage.setItem(RECOVERY_KEY, serializeProject(project));
  } catch (error) {
    removeBrowserRecoverySnapshot(storage);
    throw nativeError ?? error;
  }
}

export function readRecoverySnapshot(storage: RecoveryStorage = localStorage): Project | undefined {
  const document = storage.getItem(RECOVERY_KEY);
  if (!document) return undefined;
  try {
    return validateProjectDocument(JSON.parse(document));
  } catch {
    storage.removeItem(RECOVERY_KEY);
    return undefined;
  }
}

export async function readRecoverySnapshotForCurrentProject(): Promise<Project | undefined> {
  return (await readNativeRecoverySnapshotForCurrentProject()) ?? readRecoverySnapshot();
}

export async function readNativeRecoverySnapshotForCurrentProject(): Promise<Project | undefined> {
  if (!nativeProjectPath) return undefined;
  const candidate = await invoke<unknown>("recovery_candidate", {
    path: nativeProjectPath,
  });
  return candidate ? validateProjectDocument(hydrateRuntimeAssetUrls(candidate)) : undefined;
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

export async function relinkProjectAsset(layer: Layer): Promise<Layer["asset"] | undefined> {
  if (!nativeProjectPath || !isDesktopRuntime())
    throw new Error("Save or open this project in the native app before linking an asset");
  if (layer.kind !== "image" && layer.kind !== "video")
    throw new Error("Only image and video layers can link project assets");
  const selected = await open({
    directory: false,
    multiple: false,
    title: `Link ${layer.kind} asset`,
    filters: [
      {
        name: layer.kind === "image" ? "Images" : "Videos",
        extensions:
          layer.kind === "image"
            ? ["png", "jpg", "jpeg", "webp", "gif", "bmp", "avif"]
            : ["mp4", "webm", "mov", "m4v", "ogv"],
      },
    ],
  });
  if (typeof selected !== "string") return undefined;
  const linked = await invoke<{ relativePath: string; resolvedPath: string; name: string }>(
    "link_project_asset",
    { bundle: nativeProjectPath, source: selected, kind: layer.kind },
  );
  return {
    ...(layer.asset ?? {
      mimeType: layer.kind === "image" ? "image/*" : "video/*",
      width: Math.max(1, layer.size[0]),
      height: Math.max(1, layer.size[1]),
    }),
    name: linked.name,
    dataUrl: undefined,
    relativePath: linked.relativePath,
    runtimeUrl: convertFileSrc(linked.resolvedPath),
  };
}

export function projectDocumentForPersistence(project: Project): Project {
  const document = structuredClone(project);
  for (const composition of document.compositions)
    for (const layer of composition.layers) if (layer.asset) delete layer.asset.runtimeUrl;
  return document;
}

function hydrateRuntimeAssetUrls(value: unknown): unknown {
  if (!value || typeof value !== "object") return value;
  const document = value as {
    compositions?: Array<{ layers?: Array<{ asset?: Record<string, unknown> }> }>;
  };
  for (const composition of document.compositions ?? []) {
    for (const layer of composition.layers ?? []) {
      const asset = layer.asset;
      if (!asset) continue;
      const resolvedPath = asset.resolvedPath;
      if (typeof resolvedPath !== "string") continue;
      asset.runtimeUrl = convertFileSrc(resolvedPath);
      delete asset.resolvedPath;
    }
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
  if (layer.audioEnabled !== undefined && typeof layer.audioEnabled !== "boolean")
    throw new Error(`${path}.audioEnabled must be a boolean`);
  if (layer.audioGain !== undefined) {
    const gain = requireFiniteNumber(layer.audioGain, `${path}.audioGain`);
    if (gain < 0 || gain > 1) throw new Error(`${path}.audioGain must be between 0 and 1`);
  }
  if (layer.asset !== undefined) validateAsset(layer.asset, `${path}.asset`);
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
    const camera = requireObject(layer.camera, `${path}.camera`);
    if (!["perspective", "orthographic"].includes(String(camera.projection)))
      throw new Error(`${path}.camera.projection is invalid`);
    const fieldOfView = requireFiniteNumber(camera.fieldOfView, `${path}.camera.fieldOfView`);
    if (fieldOfView <= 0 || fieldOfView >= 180)
      throw new Error(`${path}.camera.fieldOfView must be between 0 and 180 degrees`);
    requirePositiveNumber(camera.orthographicSize, `${path}.camera.orthographicSize`);
  }
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
  if (layer.particle !== undefined) {
    if (layer.kind !== "particle") throw new Error(`${path}.particle requires particle layer kind`);
    assertParticleSettings(layer.particle, `${path}.particle`);
  }
  if (layer.kind === "particle" && layer.particle === undefined)
    throw new Error(`${path}.particle is required for particle layers`);
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
  validateBoundedNumber(animator.delay, `${path}.delay`, TEXT_ANIMATOR_LIMITS.delay);
  validateBoundedNumber(animator.stagger, `${path}.stagger`, TEXT_ANIMATOR_LIMITS.stagger);
  validateBoundedNumber(animator.duration, `${path}.duration`, TEXT_ANIMATOR_LIMITS.duration);
  validateBoundedNumber(animator.scale, `${path}.scale`, TEXT_ANIMATOR_LIMITS.scale);
  validateBoundedNumber(animator.opacity, `${path}.opacity`, TEXT_ANIMATOR_LIMITS.opacity);
  const position = requireNumberArray(animator.position, `${path}.position`, 2);
  if (position.length !== 2) throw new Error(`${path}.position must contain two values`);
  for (const [index, coordinate] of position.entries())
    validateBoundedNumber(coordinate, `${path}.position[${index}]`, TEXT_ANIMATOR_LIMITS.position);
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

function validateAsset(value: unknown, path: string): void {
  const asset = requireObject(value, path);
  if (requireString(asset.name, `${path}.name`).length > 512)
    throw new Error(`${path}.name is too long`);
  requireString(asset.mimeType, `${path}.mimeType`);
  requirePositiveNumber(asset.width, `${path}.width`);
  requirePositiveNumber(asset.height, `${path}.height`);
  if (asset.duration !== undefined) requirePositiveNumber(asset.duration, `${path}.duration`);
  if (asset.relativePath !== undefined) {
    const relativePath = requireString(asset.relativePath, `${path}.relativePath`);
    if (
      relativePath.length > 1024 ||
      relativePath.includes("\\") ||
      relativePath.split("/").some((segment) => segment === "..") ||
      relativePath.startsWith("/")
    )
      throw new Error(`${path}.relativePath must stay inside the project bundle`);
  }
  if (asset.runtimeUrl !== undefined) requireString(asset.runtimeUrl, `${path}.runtimeUrl`);
  if (asset.dataUrl === undefined) return;
  const dataUrl = requireString(asset.dataUrl, `${path}.dataUrl`);
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
