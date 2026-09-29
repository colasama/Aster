import { applyOperations, type Operation } from "../core/editing/operations";
import { prepareProjectFonts } from "../core/media/project-font-runtime";
import { activeComposition } from "../core/project/project";
import {
  loadProjectFromPath,
  saveProjectDocument,
  validateProjectDocument,
} from "../core/project/project-file";
import { type ProjectFont, projectFontMetadata } from "../core/project/project-fonts";
import type { RenderQueueViewItem, RenderQueueViewState } from "../core/rendering/render-queue";
import type { Project } from "../core/types";
import { desktopRenderQueue } from "../desktop/api";
import {
  createRenderQueueJobAsync,
  defaultRenderOutputOptions,
  type RenderQueueOutputKind,
  type RenderQueueOutputOptions,
  type RenderQueueRange,
} from "../render-queue/render-job-builder";
import { type EditorState, isProjectDirty } from "../state/editor-store";
import { AsterAgentApplicationService } from "./application-service";
import { importAutomationAsset, relinkAutomationSource } from "./automation-import";
import { type AutomationRequest, MAX_RENDER_WAIT_MS } from "./automation-protocol";
import { type ContactSheetRequest, composeContactSheet, formatSheetTime } from "./contact-sheet";
import { EDIT_LIMITS, EditError, encodedBytes, limitExceeded } from "./edit-limits";
import { checkFonts, listFonts } from "./font-tools";
import { parsePreviewOptions } from "./preview-options";
import { compareReferenceFrames, type ReferenceFrame } from "./reference-comparison";
import {
  type AgentRenderedPreviewFrame,
  renderAgentContactSheet,
  renderAgentPreview,
} from "./render-preview";
import { RequestReceipts } from "./request-receipts";

export class AutomationApplicationService {
  readonly #sessions = new Map<
    string,
    { projectId: string; service: AsterAgentApplicationService; controller: AbortController }
  >();
  readonly #receipts = new Map<
    string,
    { projectId: string; receipts: RequestReceipts; generation: number }
  >();
  /** Script modules outlive workspaces, commits and imports; reset/disconnect clears them. */
  readonly #modules = new Map<string, Map<string, string>>();
  constructor(
    readonly context: {
      read: () => EditorState;
      commit: (operations: Operation[], summary: string, expectedRevision: number) => void;
      markSaved: (projectId: string, revision: number) => void;
      loadProject: (project: Project) => void;
    },
  ) {}

  interrupt(clientId: string) {
    const receipts = this.#receipts.get(clientId);
    if (receipts) receipts.generation++;
    const session = this.#sessions.get(clientId);
    if (!session) return;
    session.controller.abort();
    session.controller = new AbortController();
    session.service.interrupt();
  }

  cancel(clientId: string, preserveReceipts = false, preserveModules = preserveReceipts) {
    if (!preserveReceipts) this.#receipts.delete(clientId);
    if (!preserveModules) this.#modules.delete(clientId);
    const session = this.#sessions.get(clientId);
    session?.controller.abort();
    session?.service.abort();
    this.#sessions.delete(clientId);
  }

  close() {
    for (const id of this.#sessions.keys()) this.cancel(id);
    this.#receipts.clear();
    this.#modules.clear();
  }

  #createSession(clientId: string) {
    const state = this.context.read();
    if (this.#sessions.size >= 8) throw new Error("Too many external editing sessions");
    const session = {
      projectId: state.project.id,
      controller: new AbortController(),
      service: new AsterAgentApplicationService({
        project: state.project,
        projectRevision: state.projectRevision,
        selection: state.selection,
        currentTime: state.currentTime,
        accessMode: "agent",
        primaryModelSupportsImages: true,
        renderPreview: renderAgentPreview,
        renderContactSheet: renderAgentContactSheet,
        scriptModules: () => Object.fromEntries(this.#modules.get(clientId) ?? []),
      }),
    };
    this.#sessions.set(clientId, session);
    return session;
  }

  async execute(request: AutomationRequest): Promise<unknown> {
    const existing = this.#sessions.get(request.clientId);
    const projectId = this.context.read().project.id;
    if (
      (existing && existing.projectId !== projectId) ||
      (this.#receipts.has(request.clientId) &&
        this.#receipts.get(request.clientId)?.projectId !== projectId)
    )
      this.cancel(request.clientId, false, true);
    if (request.name === "reset_session") this.cancel(request.clientId);
    if (
      ![
        "begin_edit_workspace",
        "execute_commands",
        "execute_aster_code",
        "submit_workspace",
        "discard_workspace",
        "commit_workspace",
      ].includes(request.name)
    )
      return this.#execute(request);
    let receipts = this.#receipts.get(request.clientId);
    if (!receipts) {
      if (this.#receipts.size >= 8) throw new EditError("busy", "Too many editing clients");
      receipts = { projectId, receipts: new RequestReceipts(), generation: 0 };
      this.#receipts.set(request.clientId, receipts);
    }
    const generation = receipts.generation;
    return receipts.receipts.run(request.name, request.arguments, () => {
      if (this.#receipts.get(request.clientId) !== receipts || receipts.generation !== generation)
        throw new EditError("cancelled", "Request cancelled before execution");
      return this.#execute(request);
    });
  }

  async #execute(request: AutomationRequest): Promise<unknown> {
    const { name, arguments: input, clientId } = request;
    const state = this.context.read();
    if (name === "reset_session") this.cancel(clientId);
    if (name === "put_script_module") return this.#putModule(clientId, input);
    if (name === "compose_contact_sheet") return composeReferenceSheet(input);
    if (name === "list_script_modules") return this.#listModules(clientId);
    let session = this.#sessions.get(clientId);
    if (session && session.projectId !== state.project.id) {
      this.cancel(clientId, false, true);
      session = undefined;
    }
    session ??= this.#createSession(clientId);
    const signal = session.controller.signal;
    if (name === "get_editor_context" || name === "reset_session") {
      return {
        projectId: state.project.id,
        projectName: state.project.name,
        projectRevision: state.projectRevision,
        activeComposition: {
          id: activeComposition(state.project).id,
          width: activeComposition(state.project).width,
          height: activeComposition(state.project).height,
          duration: activeComposition(state.project).duration,
          frameRate: activeComposition(state.project).frameRate,
        },
        currentTime: state.currentTime,
        selection: state.selection,
        accessMode: "external_automation",
        workspaceCommit: "explicit_commit_workspace",
      };
    }
    if (name === "commit_workspace") return this.#commit(session, clientId, input, signal);
    if (name === "execute_aster_code" && input.commit === true) {
      const { commit: _commit, summary, ...execution } = input;
      const status = (await session.service.executeTool("execute_aster_code", execution)) as {
        state: string;
        workspaceId: string;
        workspaceRevision: number;
        operationCount?: number;
      };
      if (status.state === "running")
        return {
          ...status,
          committed: false,
          hint: "Still running, so nothing was committed; call get_execution, then commit_workspace.",
        };
      if (status.state !== "succeeded") return { ...status, committed: false };
      if (!status.operationCount)
        return { ...status, committed: false, reason: "The script made no changes" };
      try {
        const committed = await this.#commit(
          session,
          clientId,
          {
            workspaceId: status.workspaceId,
            workspaceRevision: status.workspaceRevision,
            summary: summary ?? "External automation script",
          },
          signal,
        );
        return { ...status, ...committed };
      } catch (error) {
        throw new EditError(
          error instanceof EditError ? error.code : "commit_failed",
          `Script succeeded but commit failed: ${error instanceof Error ? error.message : String(error)}`,
          {
            ...(error instanceof EditError ? error.details : {}),
            workspaceId: status.workspaceId,
            workspaceRevision: status.workspaceRevision,
            recovery:
              "The staged workspace is preserved; inspect it, then retry commit_workspace or reset_session.",
          },
        );
      }
    }
    if (name === "import_asset") {
      this.#assertRevision(input.baseRevision, session.projectId, signal);
      const imported = await importAutomationAsset(state.project, input, signal);
      try {
        this.#assertRevision(input.baseRevision, session.projectId, signal);
        validateProjectDocument(applyOperations(state.project, imported.operations));
        this.context.commit(
          imported.operations,
          "Import asset through external automation",
          state.projectRevision,
        );
      } catch (error) {
        imported.dispose();
        throw error;
      }
      this.cancel(clientId, false, true);
      return {
        projectRevision: this.context.read().projectRevision,
        layerIds: imported.layerIds,
        warnings: imported.warnings,
      };
    }
    if (name === "relink_source") {
      this.#assertRevision(input.baseRevision, session.projectId, signal);
      const relinked = await relinkAutomationSource(state.project, input, signal);
      try {
        this.#assertRevision(input.baseRevision, session.projectId, signal);
        if (relinked.operations.length > 0) {
          validateProjectDocument(applyOperations(state.project, relinked.operations));
          this.context.commit(
            relinked.operations,
            "Relink footage through external automation",
            state.projectRevision,
          );
        }
      } catch (error) {
        relinked.dispose();
        throw error;
      }
      this.cancel(clientId, false, true);
      return {
        projectRevision: this.context.read().projectRevision,
        previousSourceId: input.sourceId,
        sourceId: relinked.sourceId,
        retargetedLayers: relinked.retargetedLayers,
        removedPrevious: input.removeOld !== false && relinked.operations.length > 0,
      };
    }
    if (name === "open_project") {
      const assertCurrent = () => {
        this.#assertRevision(input.baseRevision, session.projectId, signal);
        if (isProjectDirty(this.context.read()))
          throw new Error("Save unsaved project edits before opening another project");
        if (this.context.read().project !== state.project)
          throw new Error("The live document changed while opening the project");
      };
      assertCurrent();
      const { project } = await loadProjectFromPath(input.path as string, {
        assertCurrent,
        loaded: (project) => {
          this.context.loadProject(project);
          this.close();
        },
      });
      return {
        projectId: project.id,
        projectName: project.name,
        projectRevision: 0,
        path: input.path,
      };
    }
    if (name === "save_project") {
      this.#assertRevision(input.baseRevision, session.projectId, signal);
      const path = await saveProjectDocument(state.project, false, input.path as string);
      // Mark only the captured revision saved, so edits made while saving remain dirty.
      this.context.markSaved(state.project.id, state.projectRevision);
      return {
        path,
        savedRevision: state.projectRevision,
        currentRevision: this.context.read().projectRevision,
      };
    }
    if (name === "get_render_queue") {
      const queue = await desktopRenderQueue().snapshot();
      if (typeof input.jobId === "string")
        return renderJobView(requireRenderJob(queue, input.jobId));
      const items = [...queue.items].sort((left, right) =>
        right.manifest.createdAt.localeCompare(left.manifest.createdAt),
      );
      return {
        total: items.length,
        active: items.filter((item) => !SETTLED_RENDER_STATES.has(item.status)).length,
        jobs: items.slice(0, (input.limit as number | undefined) ?? 10).map(renderJobView),
      };
    }
    if (name === "wait_render")
      return this.#waitRender(
        input.jobId as string,
        (input.timeoutMs as number | undefined) ?? MAX_RENDER_WAIT_MS,
        signal,
      );
    if (name === "cancel_render")
      return renderJobView(
        requireRenderJob(
          await desktopRenderQueue().command({ type: "cancel", jobId: input.jobId as string }),
          input.jobId as string,
        ),
      );
    if (name === "export_render") {
      this.#assertRevision(input.baseRevision, session.projectId, signal);
      const composition = input.compositionId
        ? state.project.compositions.find((item) => item.id === input.compositionId)
        : activeComposition(state.project);
      if (!composition) throw new Error("Unknown export composition");
      const kind = input.outputKind as RenderQueueOutputKind;
      const output: RenderQueueOutputOptions =
        kind === "mp4"
          ? { ...defaultRenderOutputOptions("mp4"), includeAudio: input.includeAudio === true }
          : defaultRenderOutputOptions(kind);
      const manifest = await createRenderQueueJobAsync({
        antiAliasing: state.antiAliasing,
        project: state.project,
        projectRevision: state.projectRevision,
        composition,
        output,
        destination: input.path as string,
        range: (input.range as RenderQueueRange | undefined) ?? "composition",
        currentTime: (input.time as number | undefined) ?? state.currentTime,
      });
      manifest.id = crypto.randomUUID();
      this.#assertRevision(input.baseRevision, session.projectId, signal);
      const queue = await desktopRenderQueue().enqueue(manifest);
      const job = queue.items.find((item) => item.manifest.id === manifest.id);
      return {
        jobId: manifest.id,
        ...(job ? { job: renderJobView(job) } : {}),
        activeJobs: queue.items.filter((item) => !SETTLED_RENDER_STATES.has(item.status)).length,
        next: "Call wait_render with this jobId to block until the output is written.",
      };
    }
    if (name === "list_fonts") return listFonts(state.project, input);
    if (name === "check_fonts") return checkFonts(state.project, input.families as string[]);
    if (name === "import_font") {
      this.#assertRevision(input.baseRevision, session.projectId, signal);
      const operations: Operation[] = [{ type: "addProjectFont", font: input.font as ProjectFont }];
      const project = validateProjectDocument(applyOperations(state.project, operations));
      await prepareProjectFonts(project);
      this.#assertRevision(input.baseRevision, session.projectId, signal);
      this.context.commit(operations, "Import project font", state.projectRevision);
      this.cancel(clientId, false, true);
      return {
        projectRevision: this.context.read().projectRevision,
        font: projectFontMetadata(input.font as ProjectFont),
      };
    }
    if (name === "compare_reference") {
      const references = input.referenceFrames as ReferenceFrame[];
      const times = references.map(
        (frame) => frame.actualTime - ((input.offset as number | undefined) ?? 0),
      );
      if (times.some((time) => time < 0))
        throw new Error("Reference time offset falls before the composition");
      const preview = (await session.service.executeTool("render_preview", {
        ...input,
        times,
      })) as { frames: AgentRenderedPreviewFrame[]; status: string };
      if (preview.status !== "rendered") throw new Error("Comparison requires rendered pixels");
      return compareReferenceFrames(preview.frames, references, parsePreviewOptions(input), signal);
    }
    const result = await session.service.executeTool(name, input);
    if (name === "submit_workspace" && result && typeof result === "object")
      return { ...result, commitPolicy: "explicit_commit_workspace" };
    return result;
  }

  async #commit(
    session: { projectId: string; service: AsterAgentApplicationService },
    clientId: string,
    input: Record<string, unknown>,
    signal: AbortSignal,
  ) {
    let submitted = session.service.submittedWorkspace();
    if (
      !submitted ||
      submitted.workspaceId !== input.workspaceId ||
      submitted.workspaceRevision !== input.workspaceRevision
    ) {
      await session.service.executeTool("submit_workspace", {
        workspaceId: input.workspaceId,
        workspaceRevision: input.workspaceRevision,
        summary: (input.summary as string | undefined) ?? "External automation edit",
      });
      submitted = session.service.submittedWorkspace();
    }
    if (!submitted) throw new Error("Workspace could not be submitted for commit");
    this.#assertRevision(submitted.baseRevision, session.projectId, signal);
    this.context.commit(submitted.operations, submitted.summary, submitted.baseRevision);
    this.cancel(clientId, true);
    return {
      committed: true,
      projectRevision: this.context.read().projectRevision,
      operationCount: submitted.operations.length,
      verification: submitted.verification,
    };
  }

  async #waitRender(jobId: string, timeoutMs: number, signal: AbortSignal) {
    const queue = desktopRenderQueue();
    const deadline = Date.now() + Math.min(timeoutMs, MAX_RENDER_WAIT_MS);
    let job = requireRenderJob(await queue.snapshot(), jobId);
    while (!SETTLED_RENDER_STATES.has(job.status) && Date.now() < deadline) {
      signal.throwIfAborted();
      await new Promise<void>((resolve) => {
        const finish = () => {
          clearTimeout(timer);
          unsubscribe();
          signal.removeEventListener("abort", finish);
          resolve();
        };
        const timer = setTimeout(finish, Math.max(0, Math.min(2000, deadline - Date.now())));
        const unsubscribe = queue.onChanged((state) => {
          const changed = state.items.find((item) => item.manifest.id === jobId);
          if (changed && SETTLED_RENDER_STATES.has(changed.status)) finish();
        });
        signal.addEventListener("abort", finish, { once: true });
      });
      job = requireRenderJob(await queue.snapshot(), jobId);
    }
    const view = renderJobView(job);
    return SETTLED_RENDER_STATES.has(job.status)
      ? view
      : { ...view, timedOut: true, hint: "Still rendering; call wait_render again." };
  }

  #putModule(clientId: string, input: Record<string, unknown>) {
    const name = input.name as string;
    const modules = this.#modules.get(clientId) ?? new Map<string, string>();
    if (input.remove === true) {
      const removed = modules.delete(name);
      return { name, removed, modules: moduleList(modules) };
    }
    if (typeof input.code !== "string") throw new Error("code is required unless remove is true");
    const next = new Map(modules).set(name, input.code);
    if (next.size > EDIT_LIMITS.scriptModules)
      limitExceeded("scriptModules", next.size, EDIT_LIMITS.scriptModules);
    const bytes = [...next.values()].reduce((total, code) => total + encodedBytes(code), 0);
    if (bytes > EDIT_LIMITS.scriptModuleBytes)
      limitExceeded("scriptModuleBytes", bytes, EDIT_LIMITS.scriptModuleBytes);
    this.#modules.set(clientId, next);
    return {
      name,
      stored: true,
      modules: moduleList(next),
      usage: `aster.require(${JSON.stringify(name)})`,
    };
  }

  #listModules(clientId: string) {
    return { modules: moduleList(this.#modules.get(clientId) ?? new Map()) };
  }

  #assertRevision(expected: unknown, projectId: string, signal: AbortSignal) {
    signal.throwIfAborted();
    const live = this.context.read();
    if (live.project.id !== projectId || live.projectRevision !== expected)
      throw new EditError(
        "revision_conflict",
        `Stale project revision: current revision is ${live.projectRevision}; staged work is preserved`,
        {
          expectedRevision: expected,
          currentRevision: live.projectRevision,
          recovery: "Inspect or export the staged edits before explicitly resetting this session.",
        },
      );
  }
}

const SETTLED_RENDER_STATES = new Set(["completed", "failed", "cancelled", "paused"]);

function requireRenderJob(queue: RenderQueueViewState, jobId: string): RenderQueueViewItem {
  const job = queue.items.find((item) => item.manifest.id === jobId);
  if (!job) throw new EditError("render_job_not_found", `Render job does not exist: ${jobId}`);
  return job;
}

/** Compact job projection; full manifests stay in the editor's render queue. */
function renderJobView(item: RenderQueueViewItem) {
  const { manifest, progress } = item;
  const rate = manifest.frameRate.numerator / manifest.frameRate.denominator;
  return {
    jobId: manifest.id,
    status: item.status,
    compositionName: manifest.compositionName,
    range: {
      startTime: manifest.startFrame / rate,
      endTime: manifest.endFrameExclusive / rate,
      frames: manifest.endFrameExclusive - manifest.startFrame,
    },
    progress: {
      completedFrames: progress.completedFrames,
      totalFrames: progress.totalFrames,
      elapsedMs: progress.elapsedMs,
      ...(progress.estimatedRemainingMs === undefined
        ? {}
        : { estimatedRemainingMs: progress.estimatedRemainingMs }),
    },
    outputs: manifest.outputs.map((output) => ({
      kind: output.kind,
      destination: output.destination,
      ...(output.kind === "mp4" ? { includeAudio: output.includeAudio } : {}),
    })),
    ...(item.error ? { error: item.error } : {}),
    ...(item.startedAt ? { startedAt: item.startedAt } : {}),
    ...(item.finishedAt ? { finishedAt: item.finishedAt } : {}),
  };
}

function moduleList(modules: ReadonlyMap<string, string>) {
  return [...modules].map(([name, code]) => ({ name, bytes: encodedBytes(code) }));
}

/** Internal host call: tiles decoded reference PNGs, labeled with their actual timestamps. */
async function composeReferenceSheet(input: Record<string, unknown>) {
  const frames = input.frames as Array<{ time: number; actualTime: number; data: string }>;
  const cells = await Promise.all(
    frames.map(async (frame) => ({
      time: frame.actualTime,
      label: formatSheetTime(frame.actualTime),
      image: await createImageBitmap(
        new Blob([Uint8Array.from(atob(frame.data), (character) => character.charCodeAt(0))], {
          type: "image/png",
        }),
      ),
    })),
  );
  return {
    sheet: await composeContactSheet(cells, input.contactSheet as ContactSheetRequest),
    samples: frames.map((frame) => ({ requestedTime: frame.time, actualTime: frame.actualTime })),
  };
}
