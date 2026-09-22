import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  app,
  BrowserWindow,
  dialog,
  type FileFilter,
  ipcMain,
  Menu,
  type OpenDialogOptions,
  protocol,
  type SaveDialogOptions,
  screen,
  session,
  shell,
} from "electron";
import type {
  AgentRunRequest,
  AgentToolResponse,
  FullAccessActivationRequest,
} from "../src/ai/agent-protocol.js";
import { renderQueueView } from "../src/core/rendering/render-queue.js";
import type {
  AppPreferences,
  PersistedWindowState,
  UserPreferencePatch,
} from "../src/desktop/preferences.js";
import { type UiScale, uiScaleFactor } from "../src/ui/ui-scale.js";
import { FullAccessGrantManager } from "./agent-grants.js";
import { PiAgentHost } from "./agent-host.js";
import { AppPreferencesStore } from "./app-preferences.js";
import {
  ASSET_SCHEME,
  ASSET_SCHEME_REGISTRATION,
  createAssetProtocolHandler,
} from "./asset-protocol.js";
import { startAutomationHost } from "./automation-host.js";
import { AutomationSettingsController } from "./automation-settings.js";
import { createDiagnosticBundle, writeDiagnosticBundle } from "./diagnostics.js";
import { registerFontAccess } from "./font-access.js";
import { fullAccessDesktopBridgeRequest } from "./full-access-aster-tools.js";
import { describeFullAccessTarget, FullAccessToolService } from "./full-access-tools.js";
import { detectGpuMemoryDevices } from "./gpu-memory.js";
import { fetchLocalAsset } from "./local-file-response.js";
import { AsterLogger, isRendererLogPayload, type LogLevel, parseLogLevel } from "./logger.js";
import { discoverDesktopImageSequence } from "./media-import.js";
import { Mp4ExportManager } from "./mp4-export.js";
import { developmentProfileDirectory } from "./profile-paths.js";
import { authorizeProjectMediaExternalPaths } from "./project-media-authorization.js";
import { RenderMediaSnapshotStore } from "./render-media-snapshot-store.js";
import {
  captureAuthorizedRenderQueueInput,
  identifyRenderQueueInput,
} from "./render-queue-enqueue.js";
import { ElectronRenderHostController } from "./render-queue-host.js";
import { RenderQueueManager } from "./render-queue-manager.js";
import {
  isRenderDestinationAuthorized,
  ownedRenderOutputPath,
  renderPathKey,
} from "./render-queue-paths.js";
import { RenderQueueStore } from "./render-queue-store.js";

const DEVELOPMENT_URL = "http://127.0.0.1:1420";
const backgroundAutomation = process.argv.includes("--automation-background");
const BRIDGE_COMMANDS = new Set([
  "clear_autosave",
  "install_plugin",
  "link_project_asset",
  "load_plugin_runtime",
  "load_project",
  "pack_project",
  "plugin_registry_catalog",
  "plugin_status",
  "poll_plugin_hot_reload",
  "recovery_candidate",
  "renderer_capabilities",
  "save_autosave",
  "save_project",
  "save_render_frame",
  "set_plugin_enabled",
  "set_plugin_hot_reload",
  "set_plugin_safe_mode",
  "unpack_project",
]);
const QUIET_BRIDGE_COMMANDS = new Set(["poll_plugin_hot_reload", "save_render_frame"]);
const COMMAND_PATH_ARGUMENTS: Readonly<Record<string, readonly string[]>> = {
  clear_autosave: ["path"],
  install_plugin: ["source"],
  link_project_asset: ["bundle", "source"],
  load_project: ["path"],
  pack_project: ["bundle", "destination"],
  recovery_candidate: ["path"],
  save_autosave: ["path"],
  save_project: ["path"],
  save_render_frame: ["directory"],
  unpack_project: ["archive", "parent"],
};

protocol.registerSchemesAsPrivileged([ASSET_SCHEME_REGISTRATION]);

interface BridgeResponse {
  id: number;
  result?: unknown;
  error?: string;
}

interface PendingRequest {
  command: string;
  startedAt: number;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

class DesktopBridge {
  readonly #child: ChildProcessWithoutNullStreams;
  readonly #logger: AsterLogger;
  readonly #pending = new Map<number, PendingRequest>();
  #nextId = 1;
  #closed = false;

  constructor(
    executable: string,
    appDataDirectory: string,
    logger: AsterLogger,
    logLevel: LogLevel,
  ) {
    this.#logger = logger;
    this.#child = spawn(executable, ["--app-data-dir", appDataDirectory], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      env: {
        ...process.env,
        ASTER_LOG: process.env.ASTER_LOG ?? logLevel,
        ASTER_SESSION_ID: logger.sessionId,
      },
    });
    this.#logger.info("bridge", "process_spawned", { pid: this.#child.pid });
    const output = createInterface({ input: this.#child.stdout });
    output.on("line", (line) => this.#receive(line));
    const diagnostics = createInterface({ input: this.#child.stderr });
    diagnostics.on("line", (line) => this.#logger.ingestBridge(line));
    this.#child.once("error", (error) => this.#fail(error));
    this.#child.once("exit", (code, signal) => {
      if (this.#closed) return;
      this.#logger.error(
        "bridge",
        "process_exited_unexpectedly",
        new Error(`Desktop bridge exited (${signal ?? `code ${String(code)}`})`),
        { code, signal },
      );
      this.#fail(
        new Error(`Aster desktop bridge exited unexpectedly (${signal ?? `code ${String(code)}`})`),
      );
    });
  }

  invoke(command: string, args: Record<string, unknown>): Promise<unknown> {
    if (this.#closed) return Promise.reject(new Error("Aster desktop bridge is unavailable"));
    const id = this.#nextId;
    this.#nextId += 1;
    if (!QUIET_BRIDGE_COMMANDS.has(command))
      this.#logger.debug("bridge", "command_started", { command, requestId: id });
    return new Promise((resolveRequest, rejectRequest) => {
      this.#pending.set(id, {
        command,
        startedAt: Date.now(),
        resolve: resolveRequest,
        reject: rejectRequest,
      });
      const request = `${JSON.stringify({ id, command, args })}\n`;
      this.#child.stdin.write(request, "utf8", (error) => {
        if (!error) return;
        this.#pending.delete(id);
        this.#logger.error("bridge", "command_write_failed", error, { command, requestId: id });
        rejectRequest(error);
      });
    });
  }

  dispose(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#logger.info("bridge", "process_stopping", { pendingRequests: this.#pending.size });
    this.#child.stdin.end();
    this.#child.kill();
    this.#rejectPending(new Error("Aster desktop bridge stopped"));
  }

  #receive(line: string): void {
    let response: BridgeResponse;
    try {
      response = JSON.parse(line) as BridgeResponse;
    } catch (error) {
      this.#fail(new Error("Aster desktop bridge returned malformed JSON", { cause: error }));
      return;
    }
    if (!Number.isSafeInteger(response.id)) {
      this.#fail(new Error("Aster desktop bridge returned an invalid response id"));
      return;
    }
    const pending = this.#pending.get(response.id);
    if (!pending) {
      this.#logger.warn("bridge", "unknown_response", { requestId: response.id });
      return;
    }
    this.#pending.delete(response.id);
    const durationMs = Date.now() - pending.startedAt;
    if (typeof response.error === "string") {
      this.#logger.warn("bridge", "command_failed", {
        command: pending.command,
        requestId: response.id,
        durationMs,
        error: response.error,
      });
      pending.reject(new Error(response.error));
    } else {
      if (!QUIET_BRIDGE_COMMANDS.has(pending.command))
        this.#logger.debug("bridge", "command_completed", {
          command: pending.command,
          requestId: response.id,
          durationMs,
        });
      pending.resolve(response.result);
    }
  }

  #fail(error: Error): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#logger.error("bridge", "process_failed", error, { pendingRequests: this.#pending.size });
    this.#rejectPending(error);
  }

  #rejectPending(error: Error): void {
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
  }
}

let desktopBridge: DesktopBridge | undefined;
let piAgentHost: PiAgentHost | undefined;
let mp4ExportManager: Mp4ExportManager | undefined;
let applicationLogger: AsterLogger | undefined;
let appPreferences: AppPreferencesStore | undefined;
let renderQueueManager: RenderQueueManager | undefined;
let renderHostController: ElectronRenderHostController | undefined;
let automationSettings: AutomationSettingsController | undefined;
let primaryWindow: BrowserWindow | undefined;
let activeProjectPath: string | undefined;
let rendererRecoveryDialogOpen = false;
const MAX_PENDING_PROJECT_OPEN_REQUESTS = 32;
const pendingProjectOpenRequests: ProjectOpenRequest[] = [];
const documentStates = new Map<number, DocumentState>();
const closeAllowed = new Set<number>();
const closePromptActive = new Set<number>();
const closeAuthorizationPending = new Set<number>();
const fullAccessGrants = new FullAccessGrantManager();
const fullAccessTools = new FullAccessToolService(async (toolName, input, signal) => {
  if (signal.aborted) throw new Error("Full Access Aster tool was cancelled");
  if (!desktopBridge) throw new Error("Aster desktop bridge is unavailable");
  const request = fullAccessDesktopBridgeRequest(toolName, input);
  const result = await desktopBridge.invoke(request.command, request.arguments);
  if (signal.aborted) throw new Error("Full Access Aster tool was cancelled");
  if (toolName === "unpack_project" && typeof result === "string") grantPath(result);
  if (toolName === "link_project_asset") collectAssetPaths(result);
  return result;
});
const allowedAssets = new Map<string, string>();
const grantedPaths = new Set<string>();

interface ProjectOpenRequest {
  path?: string;
  recoverAutosave: boolean;
}

interface DocumentState {
  dirty: boolean;
  projectName: string;
}

function bridgeExecutable(): string {
  const name = process.platform === "win32" ? "aster-desktop-bridge.exe" : "aster-desktop-bridge";
  if (app.isPackaged) return join(process.resourcesPath, "bin", name);
  const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
  const debug = join(projectRoot, "target", "debug", name);
  const release = join(projectRoot, "target", "release", name);
  return existsSync(debug) ? debug : release;
}

function ffmpegExecutable(): string {
  const name = process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg";
  if (app.isPackaged) {
    const bundled = join(process.resourcesPath, "bin", name);
    if (existsSync(bundled)) return bundled;
  }
  return process.env.ASTER_FFMPEG_PATH || name;
}

function normalizeAssetPath(path: string): string {
  return renderPathKey(path);
}

function grantPath(path: string): void {
  grantedPaths.add(normalizeAssetPath(path));
}

function queueProjectOpen(request: ProjectOpenRequest): void {
  const path = request.path ? resolve(request.path) : undefined;
  if (path) grantPath(path);
  const key = `${path ?? "recovery"}:${String(request.recoverAutosave)}`;
  if (
    !pendingProjectOpenRequests.some(
      (candidate) =>
        `${candidate.path ? resolve(candidate.path) : "recovery"}:${String(candidate.recoverAutosave)}` ===
        key,
    )
  ) {
    pendingProjectOpenRequests.push({ ...request, ...(path ? { path } : {}) });
    if (pendingProjectOpenRequests.length > MAX_PENDING_PROJECT_OPEN_REQUESTS)
      pendingProjectOpenRequests.splice(
        0,
        pendingProjectOpenRequests.length - MAX_PENDING_PROJECT_OPEN_REQUESTS,
      );
  }
  notifyProjectOpenAvailable();
}

function notifyProjectOpenAvailable(): void {
  const window = primaryWindow;
  if (!window || window.isDestroyed() || window.webContents.isDestroyed()) return;
  window.webContents.send("aster:project-open-available");
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
}

function projectPathsFromCommandLine(commandLine: readonly string[]): string[] {
  return commandLine.flatMap((argument) => {
    if (!argument || argument.length > 4_096 || !argument.toLocaleLowerCase().endsWith(".aster"))
      return [];
    const path = resolve(argument);
    return existsSync(path) ? [path] : [];
  });
}

function parseDocumentState(value: unknown): DocumentState {
  if (
    !isRecord(value) ||
    typeof value.dirty !== "boolean" ||
    typeof value.projectName !== "string" ||
    value.projectName.length > 512
  )
    throw new Error("Document state is invalid");
  return { dirty: value.dirty, projectName: value.projectName };
}

async function recordRecentProject(path: string): Promise<AppPreferences | undefined> {
  activeProjectPath = resolve(path);
  const preferences = await appPreferences?.recordRecentProject(activeProjectPath);
  if (activeProjectPath.toLocaleLowerCase().endsWith(".aster"))
    app.addRecentDocument(activeProjectPath);
  return preferences;
}

async function confirmUnsavedChanges(
  owner: BrowserWindow | undefined,
  projectName: string,
): Promise<"save" | "discard" | "cancel"> {
  const locale = appPreferences?.snapshot().locale;
  const chinese = locale === "zh-CN";
  const options = {
    type: "warning" as const,
    title: chinese ? "未保存的更改" : "Unsaved changes",
    message: chinese
      ? `要保存对“${projectName}”的更改吗？`
      : `Do you want to save changes to “${projectName}”?`,
    detail: chinese
      ? "不保存将丢弃自上次保存后的更改。自动恢复快照也会被清除。"
      : "Choosing Don’t Save discards changes made since the last save and clears the recovery snapshot.",
    buttons: chinese ? ["取消", "不保存", "保存"] : ["Cancel", "Don’t Save", "Save"],
    defaultId: 2,
    cancelId: 0,
    noLink: true,
  };
  const result = owner
    ? await dialog.showMessageBox(owner, options)
    : await dialog.showMessageBox(options);
  return result.response === 2 ? "save" : result.response === 1 ? "discard" : "cancel";
}

function visibleWindowState(
  saved: PersistedWindowState | undefined,
): PersistedWindowState | undefined {
  if (!saved) return undefined;
  const candidate = { x: saved.x, y: saved.y, width: saved.width, height: saved.height };
  const display = screen.getDisplayMatching(candidate);
  const intersects =
    candidate.x + candidate.width >= display.workArea.x + 80 &&
    candidate.x <= display.workArea.x + display.workArea.width - 80 &&
    candidate.y + candidate.height >= display.workArea.y + 60 &&
    candidate.y <= display.workArea.y + display.workArea.height - 60;
  const workArea = intersects ? display.workArea : screen.getPrimaryDisplay().workArea;
  const width = Math.min(Math.max(candidate.width, 1_100), workArea.width);
  const height = Math.min(Math.max(candidate.height, 700), workArea.height);
  return {
    x: Math.min(Math.max(candidate.x, workArea.x), workArea.x + workArea.width - width),
    y: Math.min(Math.max(candidate.y, workArea.y), workArea.y + workArea.height - height),
    width,
    height,
    maximized: saved.maximized,
  };
}

function assertGrantedCommandPaths(command: string, args: Record<string, unknown>): void {
  for (const argumentName of COMMAND_PATH_ARGUMENTS[command] ?? []) {
    const value = args[argumentName];
    if (typeof value !== "string" || !grantedPaths.has(normalizeAssetPath(value))) {
      throw new Error(`Desktop command path \`${argumentName}\` was not selected by the user`);
    }
  }
}

function collectAssetPaths(value: unknown): void {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const entry of value) collectAssetPaths(entry);
    return;
  }
  for (const [key, entry] of Object.entries(value)) {
    if (key === "resolvedPath" && typeof entry === "string") {
      allowedAssets.set(normalizeAssetPath(entry), resolve(entry));
    } else {
      collectAssetPaths(entry);
    }
  }
}

function assertRenderOutputPathsAuthorized(value: unknown): void {
  if (!isRecord(value) || !Array.isArray(value.outputs))
    throw new Error("Render queue manifest outputs are invalid");
  for (const output of value.outputs) {
    if (!isRecord(output) || typeof output.destination !== "string")
      throw new Error("Render queue output destination is invalid");
    if (!isAuthorizedRenderDestination(output.destination))
      throw new Error("Render queue output destination was not selected by the user");
  }
}

function isAuthorizedRenderDestination(destination: string): boolean {
  return isRenderDestinationAuthorized(destination, grantedPaths);
}

function registerAssetProtocol(): void {
  protocol.handle(
    ASSET_SCHEME,
    createAssetProtocolHandler({
      allowedAssets,
      fetchFile: fetchLocalAsset,
    }),
  );
}

function filters(value: unknown): FileFilter[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const result = value.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const candidate = entry as { name?: unknown; extensions?: unknown };
    if (typeof candidate.name !== "string" || !Array.isArray(candidate.extensions)) return [];
    const extensions = candidate.extensions.filter(
      (extension): extension is string => typeof extension === "string",
    );
    return extensions.length > 0 ? [{ name: candidate.name, extensions }] : [];
  });
  return result.length > 0 ? result : undefined;
}

function parseAgentRequest(value: unknown): AgentRunRequest {
  if (!isRecord(value)) throw new Error("Agent request must be an object");
  const provider = value.provider;
  if (!isRecord(provider)) throw new Error("Agent provider config must be an object");
  const accessMode = value.accessMode;
  if (!(["review", "agent", "full_access"] as const).some((mode) => mode === accessMode))
    throw new Error("Agent access mode is invalid");
  if (
    typeof value.prompt !== "string" ||
    typeof value.projectId !== "string" ||
    typeof value.projectName !== "string" ||
    typeof value.projectRevision !== "number" ||
    typeof provider.baseUrl !== "string" ||
    typeof provider.model !== "string" ||
    typeof provider.supportsImages !== "boolean" ||
    !(
      provider.apiKey === null ||
      provider.apiKey === undefined ||
      typeof provider.apiKey === "string"
    ) ||
    !(value.sessionId === undefined || typeof value.sessionId === "string") ||
    !(value.grantId === undefined || typeof value.grantId === "string")
  )
    throw new Error("Agent request fields are invalid");
  if (
    value.prompt.length > 32_000 ||
    value.projectId.length > 256 ||
    value.projectName.length > 512 ||
    provider.baseUrl.length > 2_048 ||
    provider.model.length > 256 ||
    (typeof provider.apiKey === "string" && provider.apiKey.length > 16_384) ||
    (typeof value.sessionId === "string" && value.sessionId.length > 256) ||
    (typeof value.grantId === "string" && value.grantId.length > 256)
  )
    throw new Error("Agent request exceeds its protocol bounds");
  return {
    prompt: value.prompt,
    projectId: value.projectId,
    projectName: value.projectName,
    projectRevision: value.projectRevision,
    accessMode: accessMode as AgentRunRequest["accessMode"],
    provider: {
      baseUrl: provider.baseUrl,
      model: provider.model,
      apiKey: provider.apiKey ?? null,
      supportsImages: provider.supportsImages,
    },
    ...(value.sessionId ? { sessionId: value.sessionId } : {}),
    ...(value.grantId ? { grantId: value.grantId } : {}),
  };
}

function parseFullAccessActivation(value: unknown): FullAccessActivationRequest {
  if (!isRecord(value)) throw new Error("Full Access activation must be an object");
  for (const field of [
    "projectId",
    "projectName",
    "model",
    "providerBaseUrl",
    "confirmation",
  ] as const)
    if (typeof value[field] !== "string") throw new Error(`Full Access ${field} is invalid`);
  return {
    projectId: value.projectId as string,
    projectName: value.projectName as string,
    model: value.model as string,
    providerBaseUrl: value.providerBaseUrl as string,
    confirmation: value.confirmation as string,
  };
}

function parseAgentToolResponse(value: unknown): AgentToolResponse {
  if (!isRecord(value) || typeof value.requestId !== "string")
    throw new Error("Agent tool response is invalid");
  if (!(value.error === undefined || typeof value.error === "string"))
    throw new Error("Agent tool response error is invalid");
  if (typeof value.error === "string" && value.error.length > 2_000)
    throw new Error("Agent tool response error is too long");
  if (Buffer.byteLength(JSON.stringify(value.result ?? null)) > 16 * 1024 * 1024)
    throw new Error("Agent tool response exceeded its protocol budget");
  return {
    requestId: value.requestId,
    ...(value.error ? { error: value.error.slice(0, 1000) } : { result: value.result }),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function registerIpc(
  logger: AsterLogger,
  preferences: AppPreferencesStore,
  renderQueue: RenderQueueManager,
  mediaSnapshots: RenderMediaSnapshotStore,
): void {
  ipcMain.on("aster:log", (event, value: unknown) => {
    if (!isRendererLogPayload(value)) {
      logger.warn("ipc", "renderer_log_rejected", { rendererId: event.sender.id });
      return;
    }
    logger.ingestRenderer(value, event.sender.id);
  });

  ipcMain.handle("aster:preferences-get", () => preferences.snapshot());
  ipcMain.handle("aster:gpu-memory-devices", () => detectGpuMemoryDevices());

  ipcMain.handle("aster:render-queue-get", () => renderQueueView(renderQueue.snapshot()));
  ipcMain.handle("aster:render-queue-enqueue", async (_event, value: unknown) => {
    assertRenderOutputPathsAuthorized(value);
    const identified = identifyRenderQueueInput(value);
    if (renderQueue.snapshot().items.some((item) => item.manifest.id === identified.jobId))
      throw new Error(`Render job ${identified.jobId} already exists`);
    const prepared = await captureAuthorizedRenderQueueInput(
      identified,
      mediaSnapshots,
      allowedAssets,
    );
    try {
      const state = await renderQueue.enqueue(prepared.input);
      mediaSnapshots.commit(prepared.jobId);
      return renderQueueView(state);
    } catch (error) {
      // A scheduler-side failure may happen after the durable enqueue update. Keep the media in
      // that case so the persisted failed item can still be retried; discard only an uncommitted job.
      if (renderQueue.snapshot().items.some((item) => item.manifest.id === prepared.jobId))
        mediaSnapshots.commit(prepared.jobId);
      else await mediaSnapshots.discard(prepared.jobId);
      throw error;
    }
  });
  ipcMain.handle("aster:render-queue-command", async (_event, value: unknown) =>
    renderQueueView(await renderQueue.command(value)),
  );
  ipcMain.handle("aster:render-queue-reveal", (_event, value: unknown) => {
    shell.showItemInFolder(ownedRenderOutputPath(renderQueue.snapshot(), value));
  });

  ipcMain.handle("aster:preferences-update", async (_event, value: unknown) => {
    if (!isRecord(value)) throw new Error("Application preferences update must be an object");
    const updated = await preferences.updateUserPreferences(value as UserPreferencePatch);
    applyUiScaleToAllWindows(updated.uiScale);
    return updated;
  });

  ipcMain.handle("aster:preferences-migrate-legacy", async (_event, value: unknown) => {
    if (!isRecord(value)) throw new Error("Legacy application preferences must be an object");
    const updated = await preferences.migrateLegacyRendererPreferences(
      value as UserPreferencePatch,
    );
    applyUiScaleToAllWindows(updated.uiScale);
    return updated;
  });

  ipcMain.handle("aster:project-authorize-recent", async (_event, value: unknown) => {
    if (typeof value !== "string" || value.length > 4_096) return false;
    const normalized = normalizeAssetPath(value);
    const known = preferences
      .snapshot()
      .recentProjects.some((path) => normalizeAssetPath(path) === normalized);
    if (!known) return false;
    if (!existsSync(resolve(value))) {
      await preferences.removeRecentProject(value);
      return false;
    }
    grantPath(value);
    return true;
  });

  ipcMain.handle("aster:project-remember", (_event, value: unknown) => {
    if (
      typeof value !== "string" ||
      value.length > 4_096 ||
      !grantedPaths.has(normalizeAssetPath(value))
    )
      throw new Error("Recent project path is not authorized");
    return recordRecentProject(value);
  });

  ipcMain.handle("aster:project-forget-active", () => {
    activeProjectPath = undefined;
  });

  ipcMain.handle("aster:project-open-take", () => pendingProjectOpenRequests.shift());

  ipcMain.on("aster:document-state", (event, value: unknown) => {
    try {
      const state = parseDocumentState(value);
      documentStates.set(event.sender.id, state);
      BrowserWindow.fromWebContents(event.sender)?.setTitle(
        `${state.dirty ? "• " : ""}${state.projectName} — Aster`,
      );
    } catch (error) {
      logger.warn("ipc", "document_state_rejected", {
        rendererId: event.sender.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  ipcMain.handle("aster:document-confirm-replace", (event, value: unknown) => {
    const state = parseDocumentState(value);
    documentStates.set(event.sender.id, state);
    if (!state?.dirty) return "discard";
    return confirmUnsavedChanges(
      BrowserWindow.fromWebContents(event.sender) ?? undefined,
      state.projectName,
    );
  });

  ipcMain.handle("aster:document-confirm-close", (event) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    if (!window) return;
    if (!closeAuthorizationPending.delete(window.id))
      throw new Error("No document close confirmation is pending");
    closeAllowed.add(window.id);
    documentStates.set(event.sender.id, {
      ...(documentStates.get(event.sender.id) ?? { projectName: "Untitled Project" }),
      dirty: false,
    });
    window.close();
  });

  ipcMain.handle("aster:document-confirm-recovery", async (event, projectName: unknown) => {
    if (typeof projectName !== "string" || projectName.length > 512)
      throw new Error("Recovery project name is invalid");
    const owner = BrowserWindow.fromWebContents(event.sender) ?? undefined;
    const chinese = preferences.snapshot().locale === "zh-CN";
    const options = {
      type: "question" as const,
      title: chinese ? "恢复未保存的项目" : "Recover unsaved project",
      message: chinese
        ? `Aster 找到了“${projectName}”的自动恢复快照。`
        : `Aster found an autosaved recovery snapshot for “${projectName}”.`,
      detail: chinese
        ? "该快照可能来自上一次异常退出。是否恢复？"
        : "It may be from an interrupted previous session. Do you want to recover it?",
      buttons: chinese ? ["丢弃", "恢复"] : ["Discard", "Recover"],
      defaultId: 1,
      cancelId: 0,
      noLink: true,
    };
    const result = owner
      ? await dialog.showMessageBox(owner, options)
      : await dialog.showMessageBox(options);
    return result.response === 1;
  });

  ipcMain.handle("aster:diagnostics-export", async (event) => {
    const owner = BrowserWindow.fromWebContents(event.sender);
    const defaultPath = `Aster-${app.getVersion()}-diagnostics.json`;
    const result = owner
      ? await dialog.showSaveDialog(owner, {
          title: "Export Aster diagnostics",
          defaultPath,
          filters: [{ name: "Aster diagnostics", extensions: ["json"] }],
        })
      : await dialog.showSaveDialog({
          title: "Export Aster diagnostics",
          defaultPath,
          filters: [{ name: "Aster diagnostics", extensions: ["json"] }],
        });
    if (result.canceled || !result.filePath) return undefined;
    await logger.flush();
    const bundle = await createDiagnosticBundle({
      version: app.getVersion(),
      platform: process.platform,
      architecture: process.arch,
      gpuFeatureStatus: app.getGPUFeatureStatus(),
      gpuInfo: await app.getGPUInfo("basic"),
      preferences: preferences.snapshot(),
      logFile: logger.filePath,
    });
    await writeDiagnosticBundle(result.filePath, bundle);
    logger.info("diagnostics", "bundle_exported");
    return result.filePath;
  });

  ipcMain.handle("aster:invoke", async (_event, command: unknown, args: unknown) => {
    try {
      if (typeof command !== "string" || !BRIDGE_COMMANDS.has(command)) {
        throw new Error("Unsupported Aster desktop command");
      }
      if (!args || typeof args !== "object" || Array.isArray(args)) {
        throw new Error("Desktop command arguments must be an object");
      }
      if (!desktopBridge) throw new Error("Aster desktop bridge is unavailable");
      const commandArgs = args as Record<string, unknown>;
      assertGrantedCommandPaths(command, commandArgs);
      if (command === "save_project" || command === "save_autosave")
        authorizeProjectMediaExternalPaths(commandArgs.project, { allowedAssets });
      const result = await desktopBridge.invoke(command, commandArgs);
      if (command === "unpack_project" && typeof result === "string") grantPath(result);
      collectAssetPaths(result);
      if (
        (command === "load_project" || command === "save_project") &&
        typeof commandArgs.path === "string"
      )
        await recordRecentProject(commandArgs.path);
      else if (command === "unpack_project" && typeof result === "string")
        await recordRecentProject(result);
      return result;
    } catch (error) {
      logger.warn("ipc", "bridge_request_rejected", {
        command: typeof command === "string" ? command : "invalid",
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  });

  ipcMain.handle("aster:agent-run", (event, value: unknown) => {
    if (!piAgentHost) throw new Error("Aster Pi agent is unavailable");
    const request = parseAgentRequest(value);
    if (request.accessMode === "full_access")
      fullAccessGrants.require(
        event.sender.id,
        request.grantId,
        request.projectId,
        request.provider.model,
        request.provider.baseUrl,
      );
    return piAgentHost.run(event.sender, request);
  });

  ipcMain.handle("aster:full-access-activate", async (event, value: unknown) => {
    const request = parseFullAccessActivation(value);
    const owner = BrowserWindow.fromWebContents(event.sender);
    const grant = await fullAccessGrants.activate(event.sender.id, request, async () => {
      const options = {
        type: "warning" as const,
        title: "Activate Full Access",
        message: `Grant Full Access to ${request.model} for ${request.projectName}?`,
        detail:
          "Full Access allows the AI to modify or delete project content, read and write files, run programs, access the network, install plugins, overwrite exports, and send project data or preview images to the configured model provider without asking for each action. Some actions cannot be undone and may cause data loss, cost, or disclosure of private information.",
        buttons: ["Cancel", "Activate Full Access"],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      };
      const result = owner
        ? await dialog.showMessageBox(owner, options)
        : await dialog.showMessageBox(options);
      return result.response === 1;
    });
    logger.warn("agent", "full_access_activated", {
      grantId: grant.id,
      projectId: grant.projectId,
      model: grant.model,
      providerHost: grant.providerHost,
      expiresAt: grant.expiresAt,
    });
    return grant;
  });

  ipcMain.handle("aster:full-access-revoke", (event, grantId: unknown) => {
    if (typeof grantId !== "string" || !fullAccessGrants.revoke(event.sender.id, grantId))
      throw new Error("Full Access grant is not active");
    piAgentHost?.cancelOwner(event.sender.id);
    fullAccessTools.abortOwner(event.sender.id);
    logger.warn("agent", "full_access_revoked", { grantId });
  });

  ipcMain.handle("aster:agent-emergency-stop", (event, sessionId: unknown, grantId: unknown) => {
    if (typeof sessionId !== "string") throw new Error("Agent session id is required");
    if (typeof grantId === "string") fullAccessGrants.revoke(event.sender.id, grantId);
    piAgentHost?.cancelOwner(event.sender.id);
    fullAccessTools.abortOwner(event.sender.id);
    void mp4ExportManager?.cancelOwner(event.sender.id);
    logger.warn("agent", "emergency_stop", { sessionId, rendererId: event.sender.id });
  });

  ipcMain.handle("aster:agent-tool-response", (event, value: unknown) => {
    if (!piAgentHost) throw new Error("Aster Pi agent is unavailable");
    piAgentHost.respond(event.sender, parseAgentToolResponse(value));
  });

  ipcMain.handle("aster:agent-cancel", (event, sessionId: unknown) => {
    if (!piAgentHost) throw new Error("Aster Pi agent is unavailable");
    if (typeof sessionId !== "string" || !sessionId.trim())
      throw new Error("Agent session id is required");
    piAgentHost.cancel(event.sender, sessionId);
    fullAccessTools.abortSession(sessionId);
  });

  ipcMain.handle("aster:open", async (_event, value: unknown) => {
    const input = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
    const options: OpenDialogOptions = {
      title: typeof input.title === "string" ? input.title : undefined,
      filters: filters(input.filters),
      properties: [input.directory === true ? "openDirectory" : "openFile"],
    };
    if (input.multiple === true) options.properties?.push("multiSelections");
    const window = BrowserWindow.getFocusedWindow();
    const result = window
      ? await dialog.showOpenDialog(window, options)
      : await dialog.showOpenDialog(options);
    logger.debug("dialog", "open_completed", {
      cancelled: result.canceled,
      directory: input.directory === true,
      selectedCount: result.filePaths.length,
    });
    if (result.canceled) return null;
    for (const path of result.filePaths) {
      grantPath(path);
      if (input.directory !== true) allowedAssets.set(normalizeAssetPath(path), resolve(path));
    }
    return input.multiple === true ? result.filePaths : (result.filePaths[0] ?? null);
  });

  ipcMain.handle("aster:media-sequence-discover", async (_event, value: unknown) => {
    if (typeof value !== "string" || !grantedPaths.has(normalizeAssetPath(value)))
      throw new Error("Image sequence seed was not selected by the user");
    const files = await discoverDesktopImageSequence(value);
    for (const file of files) allowedAssets.set(normalizeAssetPath(file.path), resolve(file.path));
    return files;
  });

  ipcMain.handle("aster:save", async (_event, value: unknown) => {
    const input = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
    const options: SaveDialogOptions = {
      title: typeof input.title === "string" ? input.title : undefined,
      defaultPath: typeof input.defaultPath === "string" ? input.defaultPath : undefined,
      filters: filters(input.filters),
    };
    const window = BrowserWindow.getFocusedWindow();
    const result = window
      ? await dialog.showSaveDialog(window, options)
      : await dialog.showSaveDialog(options);
    logger.debug("dialog", "save_completed", { cancelled: result.canceled });
    if (!result.canceled && result.filePath) grantPath(result.filePath);
    return result.canceled ? null : (result.filePath ?? null);
  });

  ipcMain.handle("aster:mp4-start", async (event, value: unknown) => {
    if (!mp4ExportManager) throw new Error("MP4 export is unavailable");
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error("MP4 export options must be an object");
    const outputPath = (value as Record<string, unknown>).outputPath;
    if (typeof outputPath !== "string" || !grantedPaths.has(normalizeAssetPath(outputPath)))
      throw new Error("MP4 output path was not selected by the user");
    const started = await mp4ExportManager.start(value, event.sender.id);
    logger.info("export", "mp4_started", {
      jobId: started.jobId,
      encoder: started.encoder,
      rendererId: event.sender.id,
      width: (value as Record<string, unknown>).width,
      height: (value as Record<string, unknown>).height,
      frameCount: (value as Record<string, unknown>).frameCount,
    });
    return started;
  });

  ipcMain.handle("aster:mp4-frame", (event, jobId: unknown, pixels: unknown) => {
    if (!mp4ExportManager) throw new Error("MP4 export is unavailable");
    return mp4ExportManager.write(jobId, pixels, event.sender.id);
  });

  ipcMain.handle("aster:mp4-audio", (event, jobId: unknown, samples: unknown) => {
    if (!mp4ExportManager) throw new Error("MP4 export is unavailable");
    return mp4ExportManager.writeAudio(jobId, samples, event.sender.id);
  });

  ipcMain.handle("aster:mp4-finish", async (event, jobId: unknown) => {
    if (!mp4ExportManager) throw new Error("MP4 export is unavailable");
    try {
      const report = await mp4ExportManager.finish(jobId, event.sender.id);
      logger.info("export", "mp4_completed", {
        jobId: report.jobId,
        encoder: report.encoder,
        frameCount: report.frameCount,
        bytesWritten: report.bytesWritten,
        elapsedMs: report.elapsedMs,
      });
      return report;
    } catch (error) {
      logger.error("export", "mp4_failed", error, {
        jobId: typeof jobId === "string" ? jobId : "invalid",
      });
      throw error;
    }
  });

  ipcMain.handle("aster:mp4-cancel", async (event, jobId: unknown) => {
    if (!mp4ExportManager) throw new Error("MP4 export is unavailable");
    await mp4ExportManager.cancel(jobId, event.sender.id);
    logger.info("export", "mp4_cancelled", {
      jobId: typeof jobId === "string" ? jobId : "invalid",
    });
  });

  ipcMain.handle("aster:window-minimize", (event) => {
    BrowserWindow.fromWebContents(event.sender)?.minimize();
  });

  ipcMain.handle("aster:window-toggle-maximize", (event) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    if (!window) return false;
    if (window.isMaximized()) window.unmaximize();
    else window.maximize();
    return window.isMaximized();
  });

  ipcMain.handle("aster:window-is-maximized", (event) => {
    return BrowserWindow.fromWebContents(event.sender)?.isMaximized() ?? false;
  });

  ipcMain.handle("aster:window-close", (event) => {
    BrowserWindow.fromWebContents(event.sender)?.close();
  });
}

function applyUiScaleToAllWindows(scale: UiScale): void {
  for (const window of BrowserWindow.getAllWindows())
    if (!renderHostController?.isRenderHost(window.webContents.id))
      applyUiScaleToWindow(window, scale);
}

function applyUiScaleToWindow(window: BrowserWindow, scale: UiScale): void {
  if (window.isDestroyed() || window.webContents.isDestroyed()) return;
  window.webContents.setZoomFactor(uiScaleFactor(scale));
  sendDisplayMetrics(window, scale);
}

function sendDisplayMetrics(window: BrowserWindow, scale: UiScale): void {
  if (window.isDestroyed() || window.webContents.isDestroyed()) return;
  const display = screen.getDisplayMatching(window.getBounds());
  const deviceScaleFactor = display.scaleFactor;
  window.webContents.send("aster:display-metrics-changed", {
    deviceScaleFactor,
    effectiveScaleFactor: deviceScaleFactor * uiScaleFactor(scale),
    uiScale: scale,
    currentDisplayId: String(display.id),
  });
}

async function createWindow(
  logger: AsterLogger,
  preferences: AppPreferencesStore,
): Promise<BrowserWindow> {
  const restored = visibleWindowState(preferences.snapshot().windowState);
  const primaryWorkArea = screen.getPrimaryDisplay().workArea;
  const window = new BrowserWindow({
    title: "Aster — Untitled Project",
    show: !backgroundAutomation,
    frame: false,
    autoHideMenuBar: true,
    width: restored?.width ?? 1440,
    height: restored?.height ?? 900,
    ...(restored ? { x: restored.x, y: restored.y } : {}),
    minWidth: Math.min(1_100, primaryWorkArea.width),
    minHeight: Math.min(700, primaryWorkArea.height),
    backgroundColor: "#111216",
    webPreferences: {
      preload: join(dirname(fileURLToPath(import.meta.url)), "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: false,
      backgroundThrottling: !backgroundAutomation,
    },
  });
  const uiScale = preferences.snapshot().uiScale;
  window.webContents.setZoomFactor(uiScaleFactor(uiScale));
  primaryWindow = window;
  const rendererId = window.webContents.id;
  let windowStateTimer: NodeJS.Timeout | undefined;
  const persistWindowState = () => {
    if (window.isDestroyed()) return;
    const bounds = window.isMaximized() ? window.getNormalBounds() : window.getBounds();
    void preferences
      .saveWindowState({ ...bounds, maximized: window.isMaximized() })
      .catch((error: unknown) =>
        logger.warn("preferences", "window_state_save_failed", { error: String(error) }),
      );
  };
  const scheduleWindowState = () => {
    if (windowStateTimer) clearTimeout(windowStateTimer);
    windowStateTimer = setTimeout(persistWindowState, 400);
  };
  const sendMaximizedState = () => {
    if (!window.isDestroyed()) {
      window.webContents.send("aster:window-maximized", window.isMaximized());
    }
  };
  const handleDisplayMetricsChange = (
    _event: Electron.Event,
    display: Electron.Display,
    changedMetrics: string[],
  ) => {
    if (!changedMetrics.some((metric) => ["bounds", "scaleFactor", "workArea"].includes(metric)))
      return;
    const currentDisplay = screen.getDisplayMatching(window.getBounds());
    if (currentDisplay.id === display.id)
      sendDisplayMetrics(window, preferences.snapshot().uiScale);
  };
  const handleDisplayTopologyChange = () =>
    sendDisplayMetrics(window, preferences.snapshot().uiScale);
  screen.on("display-added", handleDisplayTopologyChange);
  screen.on("display-removed", handleDisplayTopologyChange);
  screen.on("display-metrics-changed", handleDisplayMetricsChange);
  window.on("maximize", sendMaximizedState);
  window.on("unmaximize", sendMaximizedState);
  window.on("maximize", scheduleWindowState);
  window.on("unmaximize", scheduleWindowState);
  window.on("move", scheduleWindowState);
  window.on("move", () => sendDisplayMetrics(window, preferences.snapshot().uiScale));
  window.on("resize", scheduleWindowState);
  window.on("close", (event) => {
    if (backgroundAutomation) return;
    persistWindowState();
    if (closeAllowed.delete(window.id)) return;
    const state = documentStates.get(window.webContents.id);
    if (!state?.dirty || window.webContents.isDestroyed()) return;
    event.preventDefault();
    if (closePromptActive.has(window.id)) return;
    closePromptActive.add(window.id);
    void confirmUnsavedChanges(window, state.projectName)
      .then((decision) => {
        closePromptActive.delete(window.id);
        if (decision === "save" || decision === "discard") {
          closeAuthorizationPending.add(window.id);
          setTimeout(() => closeAuthorizationPending.delete(window.id), 60_000);
          window.webContents.send("aster:close-requested", decision);
        }
      })
      .catch((error: unknown) => {
        closePromptActive.delete(window.id);
        logger.error("window", "close_prompt_failed", error);
      });
  });
  window.on("closed", () => {
    if (windowStateTimer) clearTimeout(windowStateTimer);
    screen.removeListener("display-added", handleDisplayTopologyChange);
    screen.removeListener("display-removed", handleDisplayTopologyChange);
    screen.removeListener("display-metrics-changed", handleDisplayMetricsChange);
    documentStates.delete(rendererId);
    closeAllowed.delete(window.id);
    closePromptActive.delete(window.id);
    closeAuthorizationPending.delete(window.id);
    if (primaryWindow === window) {
      primaryWindow = undefined;
      activeProjectPath = undefined;
    }
  });
  window.webContents.on("did-finish-load", sendMaximizedState);
  window.webContents.on("did-finish-load", () => {
    logger.info("window", "renderer_loaded", { rendererId: window.webContents.id });
    sendDisplayMetrics(window, preferences.snapshot().uiScale);
    notifyProjectOpenAvailable();
  });
  window.webContents.setWindowOpenHandler(({ url }) => {
    try {
      const external = new URL(url);
      if (external.protocol === "https:" || external.protocol === "http:") {
        void shell.openExternal(external.toString());
      }
    } catch {
      // Invalid URLs stay denied.
    }
    return { action: "deny" };
  });
  window.webContents.on("will-navigate", (event, url) => {
    const productionEntry = pathToFileURL(join(app.getAppPath(), "dist", "index.html")).toString();
    const allowed =
      app.isPackaged || backgroundAutomation
        ? url === productionEntry || url.startsWith(`${productionEntry}#`)
        : new URL(url).origin === new URL(DEVELOPMENT_URL).origin;
    if (!allowed) event.preventDefault();
  });
  window.webContents.on("render-process-gone", (_event, details) => {
    logger.error("window", "renderer_process_gone", new Error(details.reason), {
      rendererId: window.webContents.id,
      reason: details.reason,
      exitCode: details.exitCode,
    });
    void mp4ExportManager?.cancelOwner(window.webContents.id);
    piAgentHost?.cancelOwner(window.webContents.id);
    fullAccessGrants.revokeOwner(window.webContents.id);
    fullAccessTools.abortOwner(window.webContents.id);
    documentStates.delete(window.webContents.id);
    if (backgroundAutomation) {
      app.quit();
      return;
    }
    if (rendererRecoveryDialogOpen || window.isDestroyed()) return;
    rendererRecoveryDialogOpen = true;
    void dialog
      .showMessageBox(window, {
        type: "error",
        title: "Aster renderer stopped",
        message: "The editor renderer stopped unexpectedly.",
        detail:
          "Aster can reload the editor and offer the latest valid autosave. Running exports and AI operations were cancelled.",
        buttons: ["Quit", "Reload and Recover"],
        defaultId: 1,
        cancelId: 0,
        noLink: true,
      })
      .then((result) => {
        rendererRecoveryDialogOpen = false;
        if (result.response === 1) {
          queueProjectOpen({
            ...(activeProjectPath ? { path: activeProjectPath } : {}),
            recoverAutosave: true,
          });
          window.reload();
        } else {
          closeAllowed.add(window.id);
          window.close();
        }
      })
      .catch((error: unknown) => {
        rendererRecoveryDialogOpen = false;
        logger.error("window", "renderer_recovery_prompt_failed", error);
      });
  });
  if (restored?.maximized) window.maximize();
  if (app.isPackaged || backgroundAutomation)
    await window.loadFile(join(app.getAppPath(), "dist", "index.html"));
  else await window.loadURL(DEVELOPMENT_URL);
  logger.debug("window", "created", { rendererId: window.webContents.id });
  return window;
}

app.setName("Aster");
const developmentProfile = developmentProfileDirectory(
  app.getPath("appData"),
  app.isPackaged,
  app.commandLine.hasSwitch("user-data-dir"),
);
if (developmentProfile) {
  mkdirSync(developmentProfile, { recursive: true });
  app.setPath("userData", developmentProfile);
  app.setPath("sessionData", developmentProfile);
}
app.setAppUserModelId("io.github.aster-mograph.aster");

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (hasSingleInstanceLock) {
  for (const path of projectPathsFromCommandLine(process.argv))
    queueProjectOpen({ path, recoverAutosave: false });
  app.on("second-instance", (_event, commandLine) => {
    for (const path of projectPathsFromCommandLine(commandLine))
      queueProjectOpen({ path, recoverAutosave: false });
    notifyProjectOpenAvailable();
  });
  app.on("open-file", (event, path) => {
    event.preventDefault();
    if (path.toLocaleLowerCase().endsWith(".aster") && existsSync(path))
      queueProjectOpen({ path, recoverAutosave: false });
  });
} else {
  app.quit();
}

process.on("uncaughtExceptionMonitor", (error) => {
  applicationLogger?.error("application", "uncaught_exception", error);
});
process.on("unhandledRejection", (reason) => {
  applicationLogger?.error("application", "unhandled_rejection", reason);
});

if (hasSingleInstanceLock)
  void app
    .whenReady()
    .then(async () => {
      const logLevel = parseLogLevel(process.env.ASTER_LOG, app.isPackaged ? "info" : "debug");
      const logger = new AsterLogger({
        directory: join(app.getPath("userData"), "logs"),
        level: logLevel,
      });
      applicationLogger = logger;
      await logger.initialize();
      logger.info("application", "started", {
        version: app.getVersion(),
        packaged: app.isPackaged,
        platform: process.platform,
        architecture: process.arch,
        logLevel,
        logFile: logger.filePath,
      });
      const preferences = new AppPreferencesStore(app.getPath("userData"));
      const preferencesStatus = await preferences.initialize();
      appPreferences = preferences;
      if (preferencesStatus.recoveredBackup) logger.warn("preferences", "backup_recovered");
      if (preferencesStatus.resetInvalid) logger.warn("preferences", "invalid_document_reset");
      if (preferencesStatus.incompatibleFuture)
        logger.warn("preferences", "future_document_preserved");
      const renderQueueStore = new RenderQueueStore(app.getPath("userData"));
      const renderQueueStatus = await renderQueueStore.initialize();
      const renderMediaSnapshots = new RenderMediaSnapshotStore(
        join(app.getPath("userData"), "render-media-snapshots"),
      );
      // A newer queue schema may reference snapshot layouts this build cannot enumerate. Preserve
      // them verbatim together with the future queue document instead of treating them as orphans.
      if (!renderQueueStatus.incompatibleFuture)
        await renderMediaSnapshots.prune(
          new Set(renderQueueStore.snapshot().items.map((item) => item.manifest.id)),
        );
      if (renderQueueStatus.recoveredBackup) logger.warn("render_queue", "backup_recovered");
      if (renderQueueStatus.resetInvalid) logger.warn("render_queue", "invalid_document_reset");
      if (renderQueueStatus.incompatibleFuture)
        logger.warn("render_queue", "future_document_preserved");
      if (renderQueueStatus.interruptedJobs > 0)
        logger.warn("render_queue", "interrupted_jobs_recovered", {
          count: renderQueueStatus.interruptedJobs,
        });
      renderQueueManager = new RenderQueueManager(renderQueueStore, (state) => {
        void renderMediaSnapshots
          .prune(new Set(state.items.map((item) => item.manifest.id)))
          .catch((error: unknown) =>
            logger.warn("render_queue", "media_snapshot_prune_failed", {
              error: error instanceof Error ? error.message : String(error),
            }),
          );
        const view = renderQueueView(state);
        for (const window of BrowserWindow.getAllWindows())
          if (!renderHostController?.isRenderHost(window.webContents.id))
            window.webContents.send("aster:render-queue-changed", view);
      });
      const executable = bridgeExecutable();
      if (!existsSync(executable)) {
        logger.error("application", "bridge_missing", new Error("Desktop bridge was not found"), {
          executable,
        });
        if (!backgroundAutomation)
          dialog.showErrorBox(
            "Aster could not start",
            `Desktop bridge was not found at ${executable}`,
          );
        app.quit();
        return;
      }
      desktopBridge = new DesktopBridge(executable, app.getPath("userData"), logger, logLevel);
      piAgentHost = new PiAgentHost(
        logger,
        async (ownerId, sessionId, grantId, toolName, argumentsValue) => {
          fullAccessGrants.requireActive(ownerId, grantId);
          const target = describeFullAccessTarget(toolName, argumentsValue);
          logger.warn("agent", "full_access_tool_started", { sessionId, toolName, target });
          try {
            const result = await fullAccessTools.execute(
              ownerId,
              sessionId,
              toolName,
              argumentsValue,
            );
            logger.warn("agent", "full_access_tool_completed", { sessionId, toolName, target });
            return result;
          } catch (error) {
            logger.warn("agent", "full_access_tool_failed", {
              sessionId,
              toolName,
              target,
              error: error instanceof Error ? error.message : String(error),
            });
            throw error;
          }
        },
      );
      mp4ExportManager = new Mp4ExportManager(ffmpegExecutable());
      renderHostController = new ElectronRenderHostController({
        appPath: app.getAppPath(),
        developmentUrl: DEVELOPMENT_URL,
        ffmpegExecutable: ffmpegExecutable(),
        logger,
        packaged: app.isPackaged,
        authorizeMedia: (manifest) =>
          renderMediaSnapshots.authorizeLaunch(
            manifest.id,
            manifest.renderMediaSnapshot ?? '{"version":1,"entries":[],"payloads":[]}',
            { allowedAssets },
          ),
      });
      Menu.setApplicationMenu(null);
      registerAssetProtocol();
      registerIpc(logger, preferences, renderQueueManager, renderMediaSnapshots);
      renderHostController.registerIpc();
      registerFontAccess(() => primaryWindow);
      session.defaultSession.setPermissionCheckHandler(
        (contents, permission) =>
          String(permission) === "local-fonts" && contents === primaryWindow?.webContents,
      );
      session.defaultSession.setPermissionRequestHandler((contents, permission, callback) => {
        callback(String(permission) === "local-fonts" && contents === primaryWindow?.webContents);
      });
      await renderQueueManager.startScheduler(renderHostController, 1);
      await createWindow(logger, preferences);
      automationSettings = new AutomationSettingsController({
        userData: app.getPath("userData"),
        command: app.isPackaged
          ? join(
              process.resourcesPath,
              "bin",
              process.platform === "win32" ? "aster-mcp.exe" : "aster-mcp",
            )
          : process.execPath,
        launchArgs: app.isPackaged
          ? []
          : [join(app.getAppPath(), "dist-electron", "electron", "automation-mcp.js")],
        nodeMode: !app.isPackaged,
        start: (config) =>
          startAutomationHost({
            ...config,
            window: () => primaryWindow,
            ffmpeg: ffmpegExecutable(),
            ffprobe: app.isPackaged
              ? join(
                  process.resourcesPath,
                  "bin",
                  process.platform === "win32" ? "ffprobe.exe" : "ffprobe",
                )
              : process.env.ASTER_FFPROBE_PATH || "ffprobe",
            authorize: (path, media) => {
              grantPath(path);
              if (media) allowedAssets.set(normalizeAssetPath(path), resolve(path));
            },
          }),
      });
      automationSettings.registerIpc(() => primaryWindow);
      const automationState = await automationSettings.initialize();
      if (backgroundAutomation) {
        if (!automationState.running)
          throw new Error(automationState.error ?? "Background MCP failed to start");
        process.on("disconnect", () => app.quit());
        if (!process.send) throw new Error("Background Aster requires a parent IPC channel");
        process.send({ port: automationState.port });
      }
      app.on("activate", () => {
        if (!primaryWindow) void createWindow(logger, preferences);
      });
    })
    .catch((error: unknown) => {
      applicationLogger?.error("application", "startup_failed", error);
      if (backgroundAutomation) process.stderr.write(`${String(error)}\n`);
      else
        dialog.showErrorBox(
          "Aster could not start",
          error instanceof Error ? error.message : "Unexpected startup failure",
        );
      app.quit();
    });

app.on("before-quit", () => {
  applicationLogger?.info("application", "stopping");
});

let finalizingApplication = false;
app.on("will-quit", (event) => {
  if (finalizingApplication) return;
  event.preventDefault();
  finalizingApplication = true;
  desktopBridge?.dispose();
  piAgentHost?.dispose();
  void (async () => {
    await automationSettings?.close();
    await renderQueueManager?.shutdown();
    await renderHostController?.dispose();
    await Promise.all([
      mp4ExportManager?.dispose(),
      appPreferences?.flush(),
      applicationLogger?.flush(),
    ]);
  })().finally(() => app.exit(0));
});
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
