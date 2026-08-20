import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import type { Composition, Layer, Project } from "./types";

const RECOVERY_KEY = "aster.recoveryProject.v0";
let nativeProjectPath: string | undefined;

export function validateProjectDocument(value: unknown): Project {
  const project = requireObject(value, "project");
  if (project.schemaVersion !== 0) throw new Error("Unsupported Aster project schema");
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
  if (
    !project.compositions.some(
      (composition) => requireObject(composition, "composition").id === activeCompositionId,
    )
  )
    throw new Error("Active composition does not exist");
  if (typeof project.updatedAt !== "string" || Number.isNaN(Date.parse(project.updatedAt)))
    throw new Error("project.updatedAt must be an ISO date");
  return value as Project;
}

export function serializeProject(project: Project): string {
  return `${JSON.stringify(project, null, 2)}\n`;
}

export function downloadProject(project: Project): void {
  downloadBlob(
    new Blob([serializeProject(project)], { type: "application/json" }),
    `${safeFileName(project.name)}.aster.json`,
  );
}

export async function saveProjectDocument(
  project: Project,
  chooseDirectory = false,
): Promise<string | undefined> {
  if (!isTauriRuntime()) {
    downloadProject(project);
    clearRecoverySnapshot();
    return `${safeFileName(project.name)}.aster.json`;
  }
  if (chooseDirectory || !nativeProjectPath) {
    const selected = await open({
      directory: true,
      multiple: false,
      title: chooseDirectory ? "Save Aster project as…" : "Choose an Aster project folder",
    });
    if (typeof selected !== "string") return undefined;
    nativeProjectPath = selected;
  }
  await invoke("save_project", { path: nativeProjectPath, project });
  clearRecoverySnapshot();
  return nativeProjectPath;
}

export async function pickProjectFile(): Promise<{ project: Project; name: string } | undefined> {
  if (isTauriRuntime()) {
    const selected = await open({
      directory: true,
      multiple: false,
      title: "Open an Aster project folder",
    });
    if (typeof selected !== "string") return undefined;
    const project = validateProjectDocument(await invoke("load_project", { path: selected }));
    nativeProjectPath = selected;
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
          resolve({
            project: validateProjectDocument(JSON.parse(await file.text())),
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

export function storeRecoverySnapshot(project: Project): void {
  try {
    localStorage.setItem(RECOVERY_KEY, serializeProject(project));
  } catch {
    localStorage.removeItem(RECOVERY_KEY);
  }
  if (nativeProjectPath)
    void invoke("save_autosave", { path: nativeProjectPath, project }).catch(() => undefined);
}

export function readRecoverySnapshot(): Project | undefined {
  const document = localStorage.getItem(RECOVERY_KEY);
  if (!document) return undefined;
  try {
    return validateProjectDocument(JSON.parse(document));
  } catch {
    localStorage.removeItem(RECOVERY_KEY);
    return undefined;
  }
}

export async function readRecoverySnapshotForCurrentProject(): Promise<Project | undefined> {
  if (nativeProjectPath) {
    const candidate = await invoke<unknown>("recovery_candidate", {
      path: nativeProjectPath,
    });
    if (candidate) return validateProjectDocument(candidate);
  }
  return readRecoverySnapshot();
}

export function clearRecoverySnapshot(): void {
  localStorage.removeItem(RECOVERY_KEY);
  if (nativeProjectPath)
    void invoke("clear_autosave", { path: nativeProjectPath }).catch(() => undefined);
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
  requirePositiveNumber(composition.duration, `${path}.duration`);
  const frameRate = requireObject(composition.frameRate, `${path}.frameRate`);
  requirePositiveNumber(frameRate.numerator, `${path}.frameRate.numerator`);
  requirePositiveNumber(frameRate.denominator, `${path}.frameRate.denominator`);
  if (!Array.isArray(composition.background) || composition.background.length !== 4)
    throw new Error(`${path}.background must contain four channels`);
  if (!Array.isArray(composition.layers)) throw new Error(`${path}.layers must be an array`);
  const layerIds = new Set<string>();
  for (const [index, layer] of composition.layers.entries()) {
    validateLayer(layer, `${path}.layers[${index}]`);
    const id = (layer as Layer).id;
    if (layerIds.has(id)) throw new Error(`${path} contains duplicate layer id ${id}`);
    layerIds.add(id);
  }
}

function validateLayer(value: unknown, path: string): asserts value is Layer {
  const layer = requireObject(value, path);
  requireString(layer.id, `${path}.id`);
  requireString(layer.name, `${path}.name`);
  requireString(layer.kind, `${path}.kind`);
  requirePositiveNumber(layer.outPoint, `${path}.outPoint`);
  if (layer.timeOffset !== undefined) {
    const offset = requireFiniteNumber(layer.timeOffset, `${path}.timeOffset`);
    if (offset < 0) throw new Error(`${path}.timeOffset must not be negative`);
  }
  if (layer.timeStretch !== undefined)
    requirePositiveNumber(layer.timeStretch, `${path}.timeStretch`);
  if (layer.timeRemap !== undefined) validateAnimatable(layer.timeRemap, `${path}.timeRemap`);
  if (!Array.isArray(layer.size) || layer.size.length !== 2)
    throw new Error(`${path}.size must contain two values`);
  if (!Array.isArray(layer.color) || layer.color.length !== 4)
    throw new Error(`${path}.color must contain four channels`);
  requireObject(layer.transform, `${path}.transform`);
  if (!Array.isArray(layer.effects)) throw new Error(`${path}.effects must be an array`);
  for (const [index, effect] of layer.effects.entries())
    validateEffect(effect, `${path}.effects[${index}]`);
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
    previousTime = time;
  }
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
        previousTime = time;
      }
    }
  }
  if (effect.mask !== undefined) validateEffectMask(effect.mask, `${path}.mask`);
  if (effect.resource !== undefined) validateLutResource(effect.resource, `${path}.resource`);
}

function validateEffectMask(value: unknown, path: string): void {
  const mask = requireObject(value, path);
  if (mask.shape !== "ellipse" && mask.shape !== "rectangle")
    throw new Error(`${path}.shape must be ellipse or rectangle`);
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

function safeFileName(name: string): string {
  const sanitized = Array.from(name.trim(), (character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint < 32 || '<>:"/\\|?*'.includes(character) ? "-" : character;
  }).join("");
  return sanitized || "aster-project";
}

function isTauriRuntime(): boolean {
  return "__TAURI_INTERNALS__" in window;
}
