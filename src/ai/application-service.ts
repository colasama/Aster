import { buildAiContext, queryEffects } from "../core/editing/ai-context";
import type { Operation } from "../core/editing/operations";
import { prepareProjectFonts } from "../core/media/project-font-runtime";
import { activeComposition } from "../core/project/project";
import { createId, type Project } from "../core/types";
import type { AgentAccessMode, VisualObservation, VisualVerification } from "./agent-protocol";
import {
  assertRenderedFrames,
  boundedInteger,
  boundedResult,
  boundedTimes,
  changedIdsForOperation,
  finiteNumber,
  frameMeasurement,
  optionalString,
  queryValues,
  stringValue,
} from "./application-tool-values";
import {
  MAX_AI_COMMAND_BATCH,
  type NormalizedCommandBatch,
  normalizeAiCommands,
} from "./command-normalizer";
import {
  AI_COMMAND_DESCRIPTORS,
  AI_COMMAND_SCHEMA_VERSION,
  getCommandDescriptors,
  searchCommandDescriptors,
} from "./command-registry";
import { EditExecutions } from "./edit-executions";
import { EDIT_LIMITS, EditError, encodedBytes, limitExceeded } from "./edit-limits";
import { type EditTaskRunner, runEditTask } from "./edit-task";
import { type PreviewOptions, parsePreviewOptions } from "./preview-options";
import type { AgentRenderedPreviewFrame } from "./render-preview";
import { RequestReceipts } from "./request-receipts";
import { SCRIPT_API_DOCS } from "./script-api";

const MAX_QUERY_ITEMS = 128;
const MAX_WORKSPACE_BYTES = EDIT_LIMITS.workspaceBytes;
const MAX_WORKSPACE_COMMANDS = EDIT_LIMITS.operationsPerWorkspace;
const MAX_WORKSPACE_AGE_MS = EDIT_LIMITS.idleMs;

interface EditWorkspace {
  id: string;
  baseRevision: number;
  revision: number;
  project: Project;
  operations: Operation[];
  changedObjectIds: Set<string>;
  lastActivityAt: number;
  busy?: boolean;
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
  runEditTask?: EditTaskRunner;
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
  readonly #activeControllers = new Map<AbortController, string>();
  readonly #executions = new EditExecutions();
  readonly #receipts = new RequestReceipts();
  readonly #baseBytes: number;
  #submitted?: SubmittedAgentWorkspace;
  #aborted = false;
  #executionGeneration = 0;

  constructor(context: AgentApplicationContext) {
    this.#baseBytes = encodedBytes(context.project);
    this.#context = {
      ...context,
      project: structuredClone(context.project),
      selection: context.selection.slice(0, 16),
    };
  }

  async executeTool(toolName: string, argumentsValue: Record<string, unknown>): Promise<unknown> {
    if (this.#aborted) throw new Error("Agent session was aborted");
    const generation = this.#executionGeneration;
    const started = new Date();
    const argumentBytes = encodedBytes(argumentsValue);
    try {
      const result = await this.#receipts.run(toolName, argumentsValue, () => {
        if (this.#aborted || generation !== this.#executionGeneration)
          throw new EditError("cancelled", "Request cancelled before execution");
        return this.#dispatch(toolName, argumentsValue);
      });
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
    if (this.#submitted) this.#workspace(this.#submitted.workspaceId, false);
    return this.#submitted ? structuredClone(this.#submitted) : undefined;
  }

  auditEvents(): AgentToolAuditEvent[] {
    return structuredClone(this.#audit);
  }

  interrupt(): void {
    this.#executionGeneration++;
    this.#executions.interrupt();
    for (const controller of this.#activeControllers.keys()) controller.abort();
  }

  abort(): void {
    this.interrupt();
    this.#aborted = true;
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
      case "get_workspace_status":
        return this.#workspaceStatus(
          this.#workspace(stringValue(input.workspaceId, "workspaceId"), false),
        );
      case "get_script_api":
        return { ...SCRIPT_API_DOCS, limits: EDIT_LIMITS };
      case "execute_aster_code":
        return this.#executeCode(input);
      case "get_execution":
        return this.#executions.status(stringValue(input.executionId, "executionId"));
      case "cancel_execution":
        return this.#executions.cancel(stringValue(input.executionId, "executionId"));
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
    const kind = optionalString(input.kind, "kind") ?? "layers";
    const offset = boundedInteger(input.offset, "offset", 0, Number.MAX_SAFE_INTEGER, 0);
    const limit = boundedInteger(input.limit, "limit", 1, MAX_QUERY_ITEMS, 64);
    const values =
      kind === "effects"
        ? queryEffects(activeComposition(project), time)
        : queryValues(kind, buildAiContext(project, this.#context.selection, time));
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
    for (const [id, workspace] of this.#workspaces)
      if (!workspace.busy && Date.now() - workspace.lastActivityAt > MAX_WORKSPACE_AGE_MS)
        this.#workspaces.delete(id);
    if (this.#workspaces.size >= EDIT_LIMITS.maxWorkspaces)
      limitExceeded("workspaces", this.#workspaces.size + 1, EDIT_LIMITS.maxWorkspaces);
    const workspace: EditWorkspace = {
      id: createId(),
      baseRevision,
      revision: 0,
      project: this.#context.project,
      operations: [],
      changedObjectIds: new Set(),
      lastActivityAt: Date.now(),
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
        idleMs: MAX_WORKSPACE_AGE_MS,
        maxCommandsPerBatch: MAX_AI_COMMAND_BATCH,
      },
    };
  }

  async #executeCommands(input: Record<string, unknown>) {
    const workspace = this.#mutableWorkspace(input);
    if (!Array.isArray(input.commands)) throw new Error("commands must be an array");
    if (input.commands.length === 0 || input.commands.length > MAX_AI_COMMAND_BATCH)
      throw new Error(`Each batch must contain 1 through ${MAX_AI_COMMAND_BATCH} commands`);
    if (workspace.operations.length + input.commands.length > MAX_WORKSPACE_COMMANDS)
      limitExceeded(
        "operations",
        workspace.operations.length + input.commands.length,
        MAX_WORKSPACE_COMMANDS,
      );
    workspace.busy = true;
    const controller = new AbortController();
    this.#activeControllers.set(controller, workspace.id);
    try {
      const runner =
        this.#context.runEditTask ?? (typeof Worker !== "undefined" ? runEditTask : undefined);
      const batch = runner
        ? await runner(
            {
              project: workspace.project,
              currentTime: this.#context.currentTime,
              maxOperations: MAX_WORKSPACE_COMMANDS - workspace.operations.length,
              commands: input.commands,
            },
            controller.signal,
            () => {},
          )
        : normalizeAiCommands(input.commands, workspace.project, this.#context.currentTime);
      return await this.#acceptBatch(workspace, batch, controller.signal);
    } finally {
      this.#activeControllers.delete(controller);
      workspace.busy = false;
      workspace.lastActivityAt = Date.now();
    }
  }

  #executeCode(input: Record<string, unknown>) {
    if (typeof input.code !== "string" || !input.code.trim())
      throw new Error("code must be a non-empty string");
    if (encodedBytes(input.code) > EDIT_LIMITS.scriptBytes)
      limitExceeded("scriptBytes", encodedBytes(input.code), EDIT_LIMITS.scriptBytes);
    this.#executions.assertIdle();
    if (input.workspaceId === undefined && input.workspaceRevision !== undefined)
      throw new Error("workspaceRevision requires workspaceId");
    const address = input.workspaceId === undefined ? this.#beginWorkspace(input) : input;
    const workspace = this.#mutableWorkspace(address);
    const runner = this.#context.runEditTask ?? runEditTask;
    const code = input.code;
    const started = this.#executions.start(
      workspace.id,
      workspace.revision,
      async (signal, progress) => {
        try {
          signal.throwIfAborted();
          const batch = await runner(
            {
              project: workspace.project,
              currentTime: this.#context.currentTime,
              maxOperations: MAX_WORKSPACE_COMMANDS - workspace.operations.length,
              code,
            },
            signal,
            progress,
          );
          signal.throwIfAborted();
          const accepted = await this.#acceptBatch(workspace, batch, signal);
          return { workspaceRevision: accepted.workspaceRevision, result: batch.result };
        } finally {
          workspace.busy = false;
          workspace.lastActivityAt = Date.now();
        }
      },
    );
    workspace.busy = true;
    return started;
  }

  async #acceptBatch(
    workspace: EditWorkspace,
    batch: NormalizedCommandBatch,
    signal?: AbortSignal,
  ) {
    const candidate: EditWorkspace = {
      ...workspace,
      project: batch.project,
      operations: [...workspace.operations, ...batch.operations],
      changedObjectIds: new Set([...workspace.changedObjectIds, ...batch.changedObjectIds]),
      revision: workspace.revision + (batch.operations.length > 0 ? 1 : 0),
      lastActivityAt: Date.now(),
      busy: false,
      ...(batch.operations.length > 0
        ? { previewFrames: undefined, visualObservation: undefined }
        : {}),
    };
    this.#assertWorkspaceBudget(candidate);
    if (batch.operations.some((operation) => operation.type === "addProjectFont"))
      await prepareProjectFonts(candidate.project);
    signal?.throwIfAborted();
    if (this.#aborted || this.#workspaces.get(workspace.id) !== workspace)
      throw new EditError("workspace_changed", "Workspace changed during execution");
    candidate.lastActivityAt = Date.now();
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
      budgets: this.#workspaceStatus(candidate).budgets,
    };
  }

  #workspaceStatus(workspace: EditWorkspace) {
    return {
      workspaceId: workspace.id,
      baseRevision: workspace.baseRevision,
      workspaceRevision: workspace.revision,
      state: workspace.busy ? "running" : workspace.frozen ? "submitted" : "editable",
      budgets: {
        operations: { used: workspace.operations.length, limit: MAX_WORKSPACE_COMMANDS },
        bytes: {
          used: this.#workspaceBytes(workspace),
          limit: MAX_WORKSPACE_BYTES,
          baseProjectBytes: this.#baseBytes,
        },
        idleMs: MAX_WORKSPACE_AGE_MS,
        expiresAt: workspace.busy ? null : workspace.lastActivityAt + MAX_WORKSPACE_AGE_MS,
        commandsPerBatch: MAX_AI_COMMAND_BATCH,
      },
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
    if (workspace.busy) throw new EditError("workspace_busy", "Workspace has a running execution");
    if (this.#context.renderPreview) {
      const controller = new AbortController();
      this.#activeControllers.set(controller, workspace.id);
      workspace.busy = true;
      try {
        const frames = await this.#context.renderPreview(
          structuredClone(workspace.project),
          times,
          controller.signal,
          parsePreviewOptions(input),
        );
        controller.signal.throwIfAborted();
        if (this.#workspaces.get(workspace.id) !== workspace)
          throw new EditError("workspace_changed", "Workspace changed during preview");
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
      } finally {
        this.#activeControllers.delete(controller);
        workspace.busy = false;
        workspace.lastActivityAt = Date.now();
      }
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
    this.#executions.interrupt(workspaceId);
    for (const [controller, id] of this.#activeControllers)
      if (id === workspaceId) controller.abort();
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
      throw new EditError(
        "revision_conflict",
        `Stale workspace revision: expected ${workspace.revision}, received ${revision}`,
        { currentRevision: workspace.revision, expectedRevision: revision },
      );
    return workspace;
  }

  #mutableWorkspace(input: Record<string, unknown>): EditWorkspace {
    const workspace = this.#workspaceInput(input);
    if (workspace.busy) throw new EditError("workspace_busy", "Workspace has a running execution");
    if (workspace.frozen) throw new Error("Workspace is frozen");
    return workspace;
  }

  #workspace(id: string, touch = true): EditWorkspace {
    const workspace = this.#workspaces.get(id);
    if (!workspace) throw new EditError("workspace_not_found", "Edit workspace does not exist");
    if (!workspace.busy && Date.now() - workspace.lastActivityAt > MAX_WORKSPACE_AGE_MS) {
      this.#workspaces.delete(id);
      throw new EditError(
        "workspace_expired",
        "Edit workspace expired after 30 minutes of inactivity",
      );
    }
    if (touch) workspace.lastActivityAt = Date.now();
    return workspace;
  }

  #workspaceBytes(workspace: EditWorkspace) {
    return (
      encodedBytes(workspace.operations) +
      Math.max(0, encodedBytes(workspace.project) - this.#baseBytes)
    );
  }

  #assertWorkspaceBudget(workspace: EditWorkspace): void {
    const bytes = this.#workspaceBytes(workspace);
    if (bytes > MAX_WORKSPACE_BYTES) limitExceeded("workspaceBytes", bytes, MAX_WORKSPACE_BYTES);
    if (workspace.operations.length > MAX_WORKSPACE_COMMANDS)
      limitExceeded("operations", workspace.operations.length, MAX_WORKSPACE_COMMANDS);
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
