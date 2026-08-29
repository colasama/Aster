import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { existsSync } from "node:fs";
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
  net,
  type OpenDialogOptions,
  protocol,
  type SaveDialogOptions,
  session,
  shell,
} from "electron";
import type {
  AgentRunRequest,
  AgentToolResponse,
  FullAccessActivationRequest,
} from "../src/ai/agent-protocol.js";
import { FullAccessGrantManager } from "./agent-grants.js";
import { PiAgentHost } from "./agent-host.js";
import { fullAccessDesktopBridgeRequest } from "./full-access-aster-tools.js";
import { describeFullAccessTarget, FullAccessToolService } from "./full-access-tools.js";
import { AsterLogger, isRendererLogPayload, type LogLevel, parseLogLevel } from "./logger.js";
import { Mp4ExportManager } from "./mp4-export.js";

const ASSET_SCHEME = "aster-asset";
const DEVELOPMENT_URL = "http://127.0.0.1:1420";
const BRIDGE_COMMANDS = new Set([
  "clear_autosave",
  "install_plugin",
  "link_project_asset",
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

protocol.registerSchemesAsPrivileged([
  {
    scheme: ASSET_SCHEME,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
    },
  },
]);

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
  const normalized = resolve(path);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function grantPath(path: string): void {
  grantedPaths.add(normalizeAssetPath(path));
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

function registerAssetProtocol(): void {
  protocol.handle(ASSET_SCHEME, async (request) => {
    try {
      const url = new URL(request.url);
      if (url.hostname !== "local") return new Response("Not found", { status: 404 });
      const encodedPath = url.pathname.startsWith("/") ? url.pathname.slice(1) : url.pathname;
      const requestedPath = decodeURIComponent(encodedPath);
      const allowedPath = allowedAssets.get(normalizeAssetPath(requestedPath));
      if (!allowedPath) return new Response("Not found", { status: 404 });
      return net.fetch(pathToFileURL(allowedPath).toString());
    } catch {
      return new Response("Not found", { status: 404 });
    }
  });
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

function registerIpc(logger: AsterLogger): void {
  ipcMain.on("aster:log", (event, value: unknown) => {
    if (!isRendererLogPayload(value)) {
      logger.warn("ipc", "renderer_log_rejected", { rendererId: event.sender.id });
      return;
    }
    logger.ingestRenderer(value, event.sender.id);
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
      const result = await desktopBridge.invoke(command, commandArgs);
      if (command === "unpack_project" && typeof result === "string") grantPath(result);
      collectAssetPaths(result);
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
    for (const path of result.filePaths) grantPath(path);
    return input.multiple === true ? result.filePaths : (result.filePaths[0] ?? null);
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

async function createWindow(logger: AsterLogger): Promise<BrowserWindow> {
  const window = new BrowserWindow({
    title: "Aster — Untitled Project",
    frame: false,
    autoHideMenuBar: true,
    width: 1440,
    height: 900,
    minWidth: 1100,
    minHeight: 700,
    backgroundColor: "#111216",
    webPreferences: {
      preload: join(dirname(fileURLToPath(import.meta.url)), "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: false,
    },
  });
  const sendMaximizedState = () => {
    if (!window.isDestroyed()) {
      window.webContents.send("aster:window-maximized", window.isMaximized());
    }
  };
  window.on("maximize", sendMaximizedState);
  window.on("unmaximize", sendMaximizedState);
  window.webContents.on("did-finish-load", sendMaximizedState);
  window.webContents.on("did-finish-load", () => {
    logger.info("window", "renderer_loaded", { rendererId: window.webContents.id });
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
    const allowed = app.isPackaged
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
  });
  if (app.isPackaged) await window.loadFile(join(app.getAppPath(), "dist", "index.html"));
  else await window.loadURL(DEVELOPMENT_URL);
  logger.debug("window", "created", { rendererId: window.webContents.id });
  return window;
}

app.setName("Aster");
app.setAppUserModelId("io.github.aster-mograph.aster");

process.on("uncaughtExceptionMonitor", (error) => {
  applicationLogger?.error("application", "uncaught_exception", error);
});
process.on("unhandledRejection", (reason) => {
  applicationLogger?.error("application", "unhandled_rejection", reason);
});

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
    const executable = bridgeExecutable();
    if (!existsSync(executable)) {
      logger.error("application", "bridge_missing", new Error("Desktop bridge was not found"), {
        executable,
      });
      dialog.showErrorBox("Aster could not start", `Desktop bridge was not found at ${executable}`);
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
    Menu.setApplicationMenu(null);
    registerAssetProtocol();
    registerIpc(logger);
    session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => {
      callback(false);
    });
    await createWindow(logger);
    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) void createWindow(logger);
    });
  })
  .catch((error: unknown) => {
    applicationLogger?.error("application", "startup_failed", error);
    dialog.showErrorBox(
      "Aster could not start",
      error instanceof Error ? error.message : "Unexpected startup failure",
    );
    app.quit();
  });

app.on("before-quit", () => {
  applicationLogger?.info("application", "stopping");
  desktopBridge?.dispose();
  piAgentHost?.dispose();
  void mp4ExportManager?.dispose();
  void applicationLogger?.flush();
});
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
