import { buildAiContext, MAX_AI_CONTEXT_BYTES } from "../core/ai-context";
import type { Operation } from "../core/operations";
import { activeComposition } from "../core/project";
import { createId, type Project } from "../core/types";
import type { AgentAccessMode, VisualObservation, VisualVerification } from "./agent-protocol";
import { MAX_AI_COMMAND_BATCH, normalizeAiCommands } from "./command-normalizer";
import {
  AI_COMMAND_DESCRIPTORS,
  AI_COMMAND_SCHEMA_VERSION,
  getCommandDescriptors,
  searchCommandDescriptors,
} from "./command-registry";
import { type PreviewOptions, parsePreviewOptions } from "./preview-options";
import type { AgentRenderedPreviewFrame } from "./render-preview";

const MAX_QUERY_ITEMS = 128;
const MAX_QUERY_BYTES = 64 * 1024;
const MAX_WORKSPACE_BYTES = 16 * 1024 * 1024;
const MAX_WORKSPACE_COMMANDS = 128;
const MAX_WORKSPACE_AGE_MS = 10 * 60 * 1000;
const MAX_RENDER_SAMPLES = 12;

interface EditWorkspace {
  id: string;
  baseRevision: number;
  revision: number;
  project: Project;
  operations: Operation[];
  changedObjectIds: Set<string>;
  createdAt: number;
  frozen: boolean;
  previewFrames?: AgentRenderedPreviewFrame[];
  visualObservation?: VisualObservation;
}

export interface SubmittedAgentWorkspace {
  workspaceId: string;
  summary: string;
  baseRevision: number;
  workspaceRevision: number;
  operations: Operation[];
  changedObjectIds: string[];
  verification: VisualVerification;
  visualObservation?: VisualObservation;
}

export interface AgentApplicationContext {
  project: Project;
  projectRevision: number;
  selection: string[];
  currentTime: number;
  accessMode: AgentAccessMode;
  primaryModelSupportsImages: boolean;
  renderPreview?: (
    project: Project,
    times: readonly number[],
    signal: AbortSignal,
    options?: PreviewOptions,
  ) => Promise<AgentRenderedPreviewFrame[]>;
}

export interface AgentToolAuditEvent {
  toolName: string;
  startedAt: string;
  finishedAt: string;
  status: "ok" | "error";
  argumentBytes: number;
  error?: string;
}

export class AsterAgentApplicationService {
  readonly #context: AgentApplicationContext;
  readonly #workspaces = new Map<string, EditWorkspace>();
  readonly #audit: AgentToolAuditEvent[] = [];
  readonly #abortController = new AbortController();
  #submitted?: SubmittedAgentWorkspace;
  #aborted = false;

  constructor(context: AgentApplicationContext) {
    this.#context = {
      ...context,
      project: structuredClone(context.project),
      selection: context.selection.slice(0, 16),
    };
  }

  async executeTool(toolName: string, argumentsValue: Record<string, unknown>): Promise<unknown> {
    if (this.#aborted) throw new Error("Agent session was aborted");
    const started = new Date();
    const argumentBytes = encodedBytes(argumentsValue);
    try {
      const result = await this.#dispatch(toolName, argumentsValue);
      this.#recordAudit(toolName, started, "ok", argumentBytes);
      return result;
    } catch (error) {
      this.#recordAudit(
        toolName,
        started,
        "error",
        argumentBytes,
        error instanceof Error ? error.message : String(error),
      );
      throw error;
    }
  }

  submittedWorkspace(): SubmittedAgentWorkspace | undefined {
    return this.#submitted ? structuredClone(this.#submitted) : undefined;
  }

  auditEvents(): AgentToolAuditEvent[] {
    return structuredClone(this.#audit);
  }

  abort(): void {
    this.#aborted = true;
    this.#abortController.abort();
    this.#workspaces.clear();
    this.#submitted = undefined;
  }

  async #dispatch(toolName: string, input: Record<string, unknown>): Promise<unknown> {
    switch (toolName) {
      case "get_editor_context":
        return this.#editorContext();
      case "search_capabilities":
        return this.#searchCapabilities(input);
      case "get_command_schemas":
        return this.#commandSchemas(input);
      case "query_project":
        return this.#queryProject(input);
      case "begin_edit_workspace":
        return this.#beginWorkspace(input);
      case "execute_commands":
        return this.#executeCommands(input);
      case "evaluate_at_time":
        return this.#evaluateAtTime(input);
      case "render_preview":
        return this.#renderPreview(input);
      case "analyze_render":
        return this.#analyzeRender(input);
      case "inspect_diagnostics":
        return this.#inspectDiagnostics(input);
      case "submit_workspace":
        return this.#submitWorkspace(input);
      case "discard_workspace":
        return this.#discardWorkspace(input);
      default:
        throw new Error(`Agent tool is not registered: ${toolName}`);
    }
  }

  #editorContext() {
    const composition = activeComposition(this.#context.project);
    return boundedResult({
      schemaVersion: AI_COMMAND_SCHEMA_VERSION,
      projectRevision: this.#context.projectRevision,
      project: { id: this.#context.project.id, name: this.#context.project.name },
      activeComposition: { id: composition.id, name: composition.name },
      currentTime: this.#context.currentTime,
      selection: this.#context.selection,
      accessMode: this.#context.accessMode,
      capabilitySummary: Object.entries(
        AI_COMMAND_DESCRIPTORS.reduce<Record<string, number>>((counts, descriptor) => {
          counts[descriptor.category] = (counts[descriptor.category] ?? 0) + 1;
          return counts;
        }, {}),
      ).map(([category, count]) => ({ category, count })),
    });
  }

  #searchCapabilities(input: Record<string, unknown>) {
    const query = stringValue(input.query, "query", true);
    const category = optionalString(input.category, "category");
    const limit = boundedInteger(input.limit, "limit", 1, 24, 12);
    return {
      schemaVersion: AI_COMMAND_SCHEMA_VERSION,
      commands: searchCommandDescriptors(query, category, limit).map((descriptor) => ({
        name: descriptor.name,
        version: descriptor.version,
        category: descriptor.category,
        description: descriptor.description,
        requiredPermissions: descriptor.requiredPermissions,
        risk: descriptor.risk,
      })),
    };
  }

  #commandSchemas(input: Record<string, unknown>) {
    if (!Array.isArray(input.names) || input.names.length === 0 || input.names.length > 12)
      throw new Error("names must contain 1 through 12 command names");
    const names = input.names.map((name) => stringValue(name, "name"));
    return boundedResult({
      schemaVersion: AI_COMMAND_SCHEMA_VERSION,
      commands: getCommandDescriptors(names),
    });
  }

  #queryProject(input: Record<string, unknown>) {
    const workspace = optionalString(input.workspaceId, "workspaceId");
    const project = workspace ? this.#workspace(workspace).project : this.#context.project;
    const revision = workspace
      ? this.#workspace(workspace).revision
      : this.#assertLiveRevision(input.projectRevision);
    const time = finiteNumber(input.time, "time", this.#context.currentTime);
    const context = buildAiContext(project, this.#context.selection, time);
    const kind = optionalString(input.kind, "kind") ?? "layers";
    const offset = boundedInteger(input.offset, "offset", 0, Number.MAX_SAFE_INTEGER, 0);
    const limit = boundedInteger(input.limit, "limit", 1, MAX_QUERY_ITEMS, 64);
    const values = queryValues(kind, context);
    return boundedResult({
      projectRevision: revision,
      kind,
      offset,
      total: values.length,
      items: values.slice(offset, offset + limit),
    });
  }

  #beginWorkspace(input: Record<string, unknown>) {
    const baseRevision = boundedInteger(
      input.baseRevision,
      "baseRevision",
      0,
      Number.MAX_SAFE_INTEGER,
    );
    this.#assertLiveRevision(baseRevision);
    const workspace: EditWorkspace = {
      id: createId(),
      baseRevision,
      revision: 0,
      project: structuredClone(this.#context.project),
      operations: [],
      changedObjectIds: new Set(),
      createdAt: Date.now(),
      frozen: false,
    };
    this.#assertWorkspaceBudget(workspace);
    this.#workspaces.set(workspace.id, workspace);
    return {
      workspaceId: workspace.id,
      baseRevision,
      workspaceRevision: workspace.revision,
      budgets: {
        maxBytes: MAX_WORKSPACE_BYTES,
        maxCommands: MAX_WORKSPACE_COMMANDS,
        maxAgeMs: MAX_WORKSPACE_AGE_MS,
      },
    };
  }

  #executeCommands(input: Record<string, unknown>) {
    const workspace = this.#mutableWorkspace(input);
    if (!Array.isArray(input.commands)) throw new Error("commands must be an array");
    if (input.commands.length === 0 || input.commands.length > MAX_AI_COMMAND_BATCH)
      throw new Error(`Each batch must contain 1 through ${MAX_AI_COMMAND_BATCH} commands`);
    if (workspace.operations.length + input.commands.length > MAX_WORKSPACE_COMMANDS)
      throw new Error("Workspace command-count budget exceeded");
    const batch = normalizeAiCommands(input.commands, workspace.project, this.#context.currentTime);
    const candidate: EditWorkspace = {
      ...workspace,
      project: batch.project,
      operations: [...workspace.operations, ...batch.operations],
      changedObjectIds: new Set([...workspace.changedObjectIds, ...batch.changedObjectIds]),
      revision: workspace.revision + 1,
    };
    this.#assertWorkspaceBudget(candidate);
    this.#workspaces.set(candidate.id, candidate);
    return {
      workspaceId: candidate.id,
      workspaceRevision: candidate.revision,
      normalizedCommands: batch.operations.map((operation) => ({
        type: operation.type,
        changedObjectIds: changedIdsForOperation(operation),
      })),
      changedObjectIds: batch.changedObjectIds,
      diagnostics: [],
    };
  }

  #evaluateAtTime(input: Record<string, unknown>) {
    const workspace = this.#workspaceInput(input);
    const time = finiteNumber(input.time, "time");
    const context = buildAiContext(workspace.project, this.#context.selection, time);
    return boundedResult({
      workspaceId: workspace.id,
      workspaceRevision: workspace.revision,
      time,
      properties: context.properties,
      scene: context.scene,
    });
  }

  async #renderPreview(input: Record<string, unknown>) {
    const workspace = this.#workspaceInput(input);
    const times = boundedTimes(input.times);
    if (this.#context.renderPreview) {
      const frames = await this.#context.renderPreview(
        structuredClone(workspace.project),
        times,
        this.#abortController.signal,
        parsePreviewOptions(input),
      );
      assertRenderedFrames(frames, times);
      workspace.previewFrames = structuredClone(frames);
      return {
        workspaceId: workspace.id,
        workspaceRevision: workspace.revision,
        status: "rendered",
        frames,
        verification: this.#context.primaryModelSupportsImages
          ? "verified_by_primary_model"
          : "metrics_only",
        limitation: this.#context.primaryModelSupportsImages
          ? "Bounded preview images are attached to this tool result for the primary model."
          : "The primary model is text-only; only deterministic pixel metrics are exposed.",
      };
    }
    return {
      workspaceId: workspace.id,
      workspaceRevision: workspace.revision,
      status: "unavailable",
      frames: times.map((time) => ({ time, renderId: `${workspace.id}:${time.toFixed(6)}` })),
      verification: "not_verified",
      limitation:
        "No bounded GPU readback was attached to this agent session; use semantic analysis and human review.",
    };
  }

  #analyzeRender(input: Record<string, unknown>) {
    const workspace = this.#workspaceInput(input);
    const times = boundedTimes(input.times);
    const composition = activeComposition(workspace.project);
    const findings: VisualObservation["findings"] = [];
    const missingAssets = composition.layers.filter((layer) => {
      if (!layer.sourceId) return false;
      const source = workspace.project.sources.find((candidate) => candidate.id === layer.sourceId);
      return !source || (!source.dataUrl && !source.runtimeUrl);
    });
    if (missingAssets.length > 0)
      findings.push({
        severity: "error",
        message: `${missingAssets.length} layer assets are unresolved.`,
      });
    const invalidTiming = composition.layers.filter(
      (layer) => layer.inPoint < 0 || layer.outPoint <= layer.inPoint,
    );
    if (invalidTiming.length > 0)
      findings.push({
        severity: "error",
        message: `${invalidTiming.length} layers have invalid timing.`,
      });
    const previewFrames = workspace.previewFrames?.filter((frame) => times.includes(frame.time));
    if (previewFrames?.some((frame) => frame.measurements.emptyFrame))
      findings.push({ severity: "warning", message: "One or more sampled frames are empty." });
    if (
      previewFrames &&
      previewFrames.length > 1 &&
      previewFrames
        .slice(1)
        .every((frame) => (frame.measurements.differenceFromPrevious ?? 0) < 0.001)
    )
      findings.push({
        severity: "info",
        message: "The sampled frames have negligible pixel differences.",
      });
    const nativeVision = Boolean(
      this.#context.primaryModelSupportsImages && previewFrames?.length === times.length,
    );
    const observation: VisualObservation = {
      mode: nativeVision ? "native_vision" : "deterministic_metrics",
      verification: nativeVision ? "verified_by_primary_model" : "metrics_only",
      frames: times.map((time) => ({
        time,
        renderId:
          previewFrames?.find((frame) => frame.time === time)?.renderId ??
          `${workspace.id}:${time.toFixed(6)}`,
      })),
      findings,
      measurements: {
        composition: { width: composition.width, height: composition.height },
        layerCount: composition.layers.length,
        unresolvedAssetCount: missingAssets.length,
        invalidTimingCount: invalidTiming.length,
        ...(previewFrames ? { sampledFrames: previewFrames.map(frameMeasurement) } : {}),
      },
      limitations: [
        nativeVision
          ? "The primary model received bounded previews; Aster does not independently score subjective quality."
          : this.#context.primaryModelSupportsImages
            ? "Preview pixels were unavailable, so native vision could not run."
            : "The configured primary model is text-only.",
        ...(nativeVision
          ? []
          : [
              "Deterministic metrics do not judge composition, taste, emphasis, rhythm, or aesthetics.",
            ]),
      ],
      confidence: findings.length === 0 ? 0.65 : 0.9,
    };
    workspace.visualObservation = observation;
    return observation;
  }

  #inspectDiagnostics(input: Record<string, unknown>) {
    const workspaceId = optionalString(input.workspaceId, "workspaceId");
    const project = workspaceId ? this.#workspace(workspaceId).project : this.#context.project;
    const composition = activeComposition(project);
    return {
      projectRevision: workspaceId
        ? this.#workspace(workspaceId).revision
        : this.#context.projectRevision,
      diagnostics: composition.layers.flatMap((layer) => {
        const messages: Array<{
          severity: "warning" | "error";
          objectId: string;
          message: string;
        }> = [];
        if (layer.sourceId) {
          const source = project.sources.find((candidate) => candidate.id === layer.sourceId);
          if (!source || (!source.dataUrl && !source.runtimeUrl))
            messages.push({
              severity: "error",
              objectId: layer.id,
              message: "Asset is unresolved",
            });
        }
        if (layer.outPoint <= layer.inPoint)
          messages.push({
            severity: "error",
            objectId: layer.id,
            message: "Layer timing is invalid",
          });
        return messages;
      }),
    };
  }

  #submitWorkspace(input: Record<string, unknown>) {
    const workspace = this.#mutableWorkspace(input);
    if (workspace.operations.length === 0) throw new Error("Cannot submit an empty workspace");
    const summary = stringValue(input.summary, "summary").trim().slice(0, 500);
    workspace.frozen = true;
    const submitted: SubmittedAgentWorkspace = {
      workspaceId: workspace.id,
      summary,
      baseRevision: workspace.baseRevision,
      workspaceRevision: workspace.revision,
      operations: structuredClone(workspace.operations),
      changedObjectIds: [...workspace.changedObjectIds],
      verification: workspace.visualObservation?.verification ?? "not_verified",
      visualObservation: workspace.visualObservation,
    };
    this.#submitted = submitted;
    return {
      ...submitted,
      operations: submitted.operations.map((operation) => ({ type: operation.type })),
      commitPolicy: this.#context.accessMode === "full_access" ? "automatic" : "user_approval",
    };
  }

  #discardWorkspace(input: Record<string, unknown>) {
    const workspaceId = stringValue(input.workspaceId, "workspaceId");
    const discarded = this.#workspaces.delete(workspaceId);
    if (this.#submitted?.workspaceId === workspaceId) this.#submitted = undefined;
    return { workspaceId, discarded };
  }

  #assertLiveRevision(value: unknown): number {
    const revision =
      typeof value === "number"
        ? value
        : boundedInteger(value, "projectRevision", 0, Number.MAX_SAFE_INTEGER);
    if (revision !== this.#context.projectRevision)
      throw new Error(
        `Stale project revision: expected ${this.#context.projectRevision}, received ${revision}`,
      );
    return revision;
  }

  #workspaceInput(input: Record<string, unknown>): EditWorkspace {
    const workspace = this.#workspace(stringValue(input.workspaceId, "workspaceId"));
    const revision = boundedInteger(
      input.workspaceRevision,
      "workspaceRevision",
      0,
      Number.MAX_SAFE_INTEGER,
    );
    if (revision !== workspace.revision)
      throw new Error(
        `Stale workspace revision: expected ${workspace.revision}, received ${revision}`,
      );
    return workspace;
  }

  #mutableWorkspace(input: Record<string, unknown>): EditWorkspace {
    const workspace = this.#workspaceInput(input);
    if (workspace.frozen) throw new Error("Workspace is frozen");
    return workspace;
  }

  #workspace(id: string): EditWorkspace {
    const workspace = this.#workspaces.get(id);
    if (!workspace) throw new Error("Edit workspace does not exist");
    if (Date.now() - workspace.createdAt > MAX_WORKSPACE_AGE_MS) {
      this.#workspaces.delete(id);
      throw new Error("Edit workspace expired");
    }
    return workspace;
  }

  #assertWorkspaceBudget(workspace: EditWorkspace): void {
    if (encodedBytes(workspace.project) + encodedBytes(workspace.operations) > MAX_WORKSPACE_BYTES)
      throw new Error("Workspace byte budget exceeded");
  }

  #recordAudit(
    toolName: string,
    started: Date,
    status: AgentToolAuditEvent["status"],
    argumentBytes: number,
    error?: string,
  ): void {
    this.#audit.push({
      toolName,
      startedAt: started.toISOString(),
      finishedAt: new Date().toISOString(),
      status,
      argumentBytes,
      ...(error ? { error: error.slice(0, 500) } : {}),
    });
    if (this.#audit.length > 512) this.#audit.splice(0, this.#audit.length - 512);
  }
}

function queryValues(kind: string, context: ReturnType<typeof buildAiContext>): unknown[] {
  switch (kind) {
    case "project":
      return [context.project];
    case "compositions":
      return [context.composition];
    case "layers":
      return context.timeline;
    case "properties":
      return context.properties;
    case "effects":
      return context.properties.flatMap((layer) =>
        layer.effects.map((effect) => ({ layerId: layer.id, ...effect })),
      );
    case "assets":
      return context.assets;
    case "scene":
      return context.scene;
    default:
      throw new Error(`Unsupported project query kind: ${kind}`);
  }
}

function changedIdsForOperation(operation: Operation): string[] {
  if ("layerId" in operation) return [operation.layerId];
  if ("compositionId" in operation) return [operation.compositionId];
  if (operation.type === "addLayer") return [operation.layer.id];
  if (operation.type === "addComposition") return [operation.composition.id];
  if (operation.type === "addProjectFolder") return [operation.folder.id];
  if (operation.type === "moveProjectItem") return [operation.itemId];
  if (operation.type === "precomposeLayers")
    return [operation.wrapper.id, operation.nestedComposition.id, ...operation.selectedIds];
  return [];
}

function boundedResult<T>(value: T): T {
  if (encodedBytes(value) > Math.min(MAX_QUERY_BYTES, MAX_AI_CONTEXT_BYTES))
    throw new Error("Agent query result exceeded its byte budget");
  return value;
}

function assertRenderedFrames(
  frames: readonly AgentRenderedPreviewFrame[],
  times: readonly number[],
): void {
  if (frames.length !== times.length) throw new Error("Agent preview renderer omitted frames");
  let encodedCharacters = 0;
  for (const [index, frame] of frames.entries()) {
    if (frame.time !== times[index]) throw new Error("Agent preview renderer changed sample times");
    if (!frame.renderId || frame.renderId.length > 256)
      throw new Error("Agent preview render ID is invalid");
    if (frame.mimeType !== "image/png") throw new Error("Agent preview format is unsupported");
    if (
      !Number.isSafeInteger(frame.width) ||
      !Number.isSafeInteger(frame.height) ||
      frame.width < 1 ||
      frame.height < 1 ||
      frame.width > 2048 ||
      frame.height > 2048
    )
      throw new Error("Agent preview dimensions are outside their bounds");
    if (!/^[A-Za-z0-9+/]*={0,2}$/u.test(frame.data))
      throw new Error("Agent preview image is not base64 encoded");
    encodedCharacters += frame.data.length;
    for (const value of Object.values(frame.measurements))
      if (typeof value === "number" && !Number.isFinite(value))
        throw new Error("Agent preview measurement is not finite");
  }
  if (encodedCharacters > 12 * 1024 * 1024)
    throw new Error("Agent preview transport exceeded its byte budget");
}

function frameMeasurement(frame: AgentRenderedPreviewFrame) {
  return {
    time: frame.time,
    renderId: frame.renderId,
    width: frame.width,
    height: frame.height,
    ...frame.measurements,
  };
}

function boundedTimes(value: unknown): number[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_RENDER_SAMPLES)
    throw new Error(`times must contain 1 through ${MAX_RENDER_SAMPLES} entries`);
  return [...new Set(value.map((entry) => finiteNumber(entry, "time")))].sort(
    (left, right) => left - right,
  );
}

function encodedBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

function stringValue(value: unknown, name: string, allowEmpty = false): string {
  if (typeof value !== "string" || (!allowEmpty && !value.trim()))
    throw new Error(`${name} must be a non-empty string`);
  if (value.length > 500) throw new Error(`${name} is too long`);
  return value;
}

function optionalString(value: unknown, name: string): string | undefined {
  return value === undefined ? undefined : stringValue(value, name);
}

function finiteNumber(value: unknown, name: string, fallback?: number): number {
  if (value === undefined && fallback !== undefined) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value))
    throw new Error(`${name} must be finite`);
  return value;
}

function boundedInteger(
  value: unknown,
  name: string,
  minimum: number,
  maximum: number,
  fallback?: number,
): number {
  if (value === undefined && fallback !== undefined) return fallback;
  if (typeof value !== "number" || !Number.isSafeInteger(value))
    throw new Error(`${name} must be an integer`);
  if (value < minimum || value > maximum) throw new Error(`${name} is outside its bounds`);
  return value;
}
