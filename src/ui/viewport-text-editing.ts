import type { Operation } from "../core/editing/operations";
import { visibleLayersAtTime } from "../core/scene/scene-evaluation";
import type { Composition, Id, Project } from "../core/types";

export interface ViewportTextEditSession {
  readonly compositionId: Id;
  readonly historyBase: Project;
  readonly initialText: string;
  readonly layerId: Id;
  readonly value: string;
}

export interface ViewportTextEditCommit {
  readonly historyBase: Project;
  readonly operations: readonly Operation[];
}

export function beginViewportTextEdit(
  project: Project,
  composition: Composition,
  layerId: Id,
  time: number,
): ViewportTextEditSession | undefined {
  const layer = editableViewportTextLayer(composition, layerId, time);
  if (!layer) return undefined;
  const text = layer.text ?? "";
  return {
    compositionId: composition.id,
    historyBase: project,
    initialText: text,
    layerId,
    value: text,
  };
}

export function updateViewportTextEdit(
  session: ViewportTextEditSession,
  value: string,
): ViewportTextEditSession {
  return { ...session, value: value.slice(0, 20_000) };
}

/**
 * Builds a renderer-only snapshot. The editor project and undo history stay untouched until commit,
 * so autosave and other panels can never observe a half-finished source-text transaction.
 */
export function previewViewportTextEdit(
  project: Project,
  composition: Composition,
  time: number,
  session: ViewportTextEditSession | undefined,
): Project {
  if (!session || session.compositionId !== composition.id) return project;
  if (session.historyBase !== project) return project;
  if (project.activeCompositionId !== session.compositionId) return project;
  const layer = editableViewportTextLayer(composition, session.layerId, time);
  if (!layer || (layer.text ?? "") === session.value) return project;
  const compositionIndex = project.compositions.findIndex(
    (candidate) => candidate.id === session.compositionId,
  );
  if (compositionIndex < 0) return project;
  const sourceComposition = project.compositions[compositionIndex];
  const layerIndex = sourceComposition.layers.findIndex(
    (candidate) => candidate.id === session.layerId,
  );
  if (layerIndex < 0) return project;
  const layers = sourceComposition.layers.slice();
  layers[layerIndex] = { ...layers[layerIndex], text: session.value };
  const compositions = project.compositions.slice();
  compositions[compositionIndex] = { ...sourceComposition, layers };
  return { ...project, compositions };
}

export function commitViewportTextEdit(
  session: ViewportTextEditSession,
): ViewportTextEditCommit | undefined {
  if (session.value === session.initialText) return undefined;
  return {
    historyBase: session.historyBase,
    operations: [textContentOperation(session)],
  };
}

export function canEditViewportText(composition: Composition, layerId: Id, time: number): boolean {
  return editableViewportTextLayer(composition, layerId, time) !== undefined;
}

function editableViewportTextLayer(composition: Composition, layerId: Id, time: number) {
  const layer = visibleLayersAtTime(composition, time).find(
    (candidate) => candidate.id === layerId,
  );
  return layer?.kind === "text" && !layer.locked ? layer : undefined;
}

function textContentOperation(session: ViewportTextEditSession): Operation {
  return { type: "setTextContent", layerId: session.layerId, text: session.value };
}
