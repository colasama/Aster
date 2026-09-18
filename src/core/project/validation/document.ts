import { normalizeWorkArea } from "../../animation/timeline-editing";

import {
  MAX_COMMAND_LOG_ENTRIES,
  MAX_COMMAND_LOG_SIZE,
  MAX_SERIALIZED_COMMAND_SIZE,
} from "../../editing/command-log";

import { sourceSupportsLayer } from "../../media/footage-source";

import type { Composition, FootageSource, Layer, Project } from "../../types";

import { validateProjectFonts } from "../project-fonts";

import { assertProjectRenderBoundaries } from "../project-render-boundaries";

import { cloneCurrentProjectDocument } from "../project-schema";
import { validateLayer } from "./layers";

import { validateFootageSource } from "./sources";
import {
  requireFiniteNumber,
  requireObject,
  requirePositiveNumber,
  requireString,
  validateBoundedNumber,
} from "./values";

export function validateProjectDocument(value: unknown): Project {
  const current = cloneCurrentProjectDocument(value);
  const project = requireObject(current, "project");
  if (project.schemaVersion !== 11) throw new Error("Unsupported Aster project schema");
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
