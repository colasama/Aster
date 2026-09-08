import { applyOperations, type Operation } from "../core/operations";
import { activeComposition } from "../core/project";
import {
  loadProjectFromPath,
  saveProjectDocument,
  validateProjectDocument,
} from "../core/project-file";
import { prepareProjectFonts } from "../core/project-font-runtime";
import { type ProjectFont, projectFontMetadata } from "../core/project-fonts";
import type { Project } from "../core/types";
import { desktopRenderQueue } from "../desktop/api";
import {
  createRenderQueueJobAsync,
  type RenderQueueOutputKind,
  type RenderQueueRange,
} from "../render-queue/render-job-builder";
import { type EditorState, isProjectDirty } from "../state/editor-store";
import { AsterAgentApplicationService } from "./application-service";
import { importAutomationAsset } from "./automation-import";
import type { AutomationRequest } from "./automation-protocol";
import { checkFonts, listFonts } from "./font-tools";
import { parsePreviewOptions } from "./preview-options";
import { compareReferenceFrames, type ReferenceFrame } from "./reference-comparison";
import { type AgentRenderedPreviewFrame, renderAgentPreview } from "./render-preview";

export class AutomationApplicationService {
  readonly #sessions = new Map<
    string,
    { projectId: string; service: AsterAgentApplicationService; controller: AbortController }
  >();
  constructor(
    readonly context: {
      read: () => EditorState;
      commit: (operations: Operation[], summary: string, expectedRevision: number) => void;
      markSaved: (projectId: string, revision: number) => void;
      loadProject: (project: Project) => void;
    },
  ) {}

  cancel(clientId: string) {
    const session = this.#sessions.get(clientId);
    session?.controller.abort();
    session?.service.abort();
    this.#sessions.delete(clientId);
  }

  close() {
    for (const id of this.#sessions.keys()) this.cancel(id);
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
      }),
    };
    this.#sessions.set(clientId, session);
    return session;
  }

  async execute(request: AutomationRequest): Promise<unknown> {
    const { name, arguments: input, clientId } = request;
    const state = this.context.read();
    if (name === "reset_session") this.cancel(clientId);
    let session = this.#sessions.get(clientId);
    if (session && session.projectId !== state.project.id) {
      this.cancel(clientId);
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
    if (name === "commit_workspace") {
      const submitted = session.service.submittedWorkspace();
      if (
        !submitted ||
        submitted.workspaceId !== input.workspaceId ||
        submitted.workspaceRevision !== input.workspaceRevision
      )
        throw new Error("Submit this workspace and use its exact revision before committing");
      this.#assertRevision(submitted.baseRevision, session.projectId, signal);
      this.context.commit(submitted.operations, submitted.summary, submitted.baseRevision);
      this.cancel(clientId);
      return {
        committed: true,
        projectRevision: this.context.read().projectRevision,
        verification: submitted.verification,
      };
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
      this.cancel(clientId);
      return {
        projectRevision: this.context.read().projectRevision,
        layerIds: imported.layerIds,
        warnings: imported.warnings,
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
    if (name === "get_render_queue") return desktopRenderQueue().snapshot();
    if (name === "cancel_render")
      return desktopRenderQueue().command({ type: "cancel", jobId: input.jobId as string });
    if (name === "export_render") {
      this.#assertRevision(input.baseRevision, session.projectId, signal);
      const composition = input.compositionId
        ? state.project.compositions.find((item) => item.id === input.compositionId)
        : activeComposition(state.project);
      if (!composition) throw new Error("Unknown export composition");
      const manifest = await createRenderQueueJobAsync({
        project: state.project,
        projectRevision: state.projectRevision,
        composition,
        outputKind: input.outputKind as RenderQueueOutputKind,
        destination: input.path as string,
        range: (input.range as RenderQueueRange | undefined) ?? "composition",
        currentTime: (input.time as number | undefined) ?? state.currentTime,
      });
      if (input.includeAudio)
        for (const output of manifest.outputs)
          if (output.kind === "mp4") output.includeAudio = true;
      manifest.id = crypto.randomUUID();
      this.#assertRevision(input.baseRevision, session.projectId, signal);
      const queue = await desktopRenderQueue().enqueue(manifest);
      return { jobId: manifest.id, queue };
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
      this.cancel(clientId);
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

  #assertRevision(expected: unknown, projectId: string, signal: AbortSignal) {
    signal.throwIfAborted();
    const live = this.context.read();
    if (live.project.id !== projectId || live.projectRevision !== expected)
      throw new Error(
        `Stale project revision: current revision is ${live.projectRevision}; reset the session before editing`,
      );
  }
}
