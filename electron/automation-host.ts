import { randomUUID } from "node:crypto";
import { access, realpath, stat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { type BrowserWindow, ipcMain } from "electron";
import type { AutomationRequest } from "../src/ai/automation-protocol.js";
import { type AutomationCall, startAutomationServer } from "./automation-server.js";
import { readProjectFont } from "./font-files.js";
import { mediaMimeType, ReferenceMediaService } from "./reference-media.js";

export async function startAutomationHost(options: {
  token: string;
  port: number;
  window: () => BrowserWindow | undefined;
  ffmpeg: string;
  ffprobe: string;
  authorize: (path: string, media: boolean) => void;
}) {
  const token = options.token;
  const media = new ReferenceMediaService(options.ffmpeg, options.ffprobe);
  const pending = new Map<
    string,
    { rendererId: number; resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  const cancel = (clientId: string) =>
    options.window()?.webContents.send("aster:automation-cancel", clientId);
  ipcMain.handle("aster:automation-response", (event, value: unknown) => {
    if (
      !value ||
      typeof value !== "object" ||
      !("requestId" in value) ||
      typeof value.requestId !== "string"
    )
      throw new Error("Invalid automation response");
    const request = pending.get(value.requestId);
    if (!request || request.rendererId !== event.sender.id)
      throw new Error("Unknown automation response owner");
    if (JSON.stringify(value).length > 48 * 1024 * 1024)
      throw new Error("Automation response exceeds its budget");
    if ("error" in value && typeof value.error === "string") request.reject(new Error(value.error));
    else request.resolve("result" in value ? value.result : undefined);
    pending.delete(value.requestId);
  });

  function renderer(call: AutomationCall, signal: AbortSignal): Promise<unknown> {
    signal.throwIfAborted();
    const window = options.window();
    if (!window || window.isDestroyed() || window.webContents.isLoadingMainFrame())
      throw new Error("Open Aster and wait for the editor to finish loading");
    const request: AutomationRequest = { ...call, requestId: randomUUID() };
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        pending.delete(request.requestId);
        signal.removeEventListener("abort", abort);
        window.webContents.off("destroyed", destroyed);
      };
      const abort = () => {
        cleanup();
        cancel(call.clientId);
        reject(new Error("Automation request cancelled"));
      };
      const destroyed = () => {
        cleanup();
        reject(new Error("Aster editor closed during automation"));
      };
      pending.set(request.requestId, {
        rendererId: window.webContents.id,
        resolve: (value) => {
          cleanup();
          resolve(value);
        },
        reject: (error) => {
          cleanup();
          reject(error);
        },
      });
      signal.addEventListener("abort", abort, { once: true });
      window.webContents.once("destroyed", destroyed);
      window.webContents.send("aster:automation-request", request);
    });
  }

  async function execute(call: AutomationCall, signal: AbortSignal) {
    const input = call.arguments;
    if (call.name === "import_font") {
      const font = await readProjectFont(input.path, input.family, input.weight);
      return renderer({ ...call, arguments: { ...input, font } }, signal);
    }
    if (call.name === "probe_reference") return media.probe(input.path, signal);
    if (call.name === "read_reference_frames") return media.frames(input, signal);
    if (call.name === "read_reference_audio") return media.audio(input, signal);
    if (call.name === "compare_reference") {
      const offset = (input.offset as number | undefined) ?? 0;
      const reference = await media.frames(
        { ...input, times: (input.times as number[]).map((time) => time + offset) },
        signal,
      );
      return renderer(
        { ...call, arguments: { ...input, referenceFrames: reference.frames } },
        signal,
      );
    }
    if (["import_asset", "save_project", "export_render"].includes(call.name)) {
      if (typeof input.path !== "string" || !isAbsolute(input.path))
        throw new Error("Use an absolute local path");
      if (call.name === "import_asset") {
        const path = await realpath(input.path);
        const info = await stat(path);
        const mimeType = mediaMimeType(path);
        if (
          !info.isFile() ||
          info.size < 1 ||
          info.size > 96 * 1024 * 1024 ||
          mimeType === "application/octet-stream"
        )
          throw new Error("Import requires a supported media file of at most 96 MiB");
        options.authorize(path, true);
        return renderer(
          { ...call, arguments: { ...input, path, mimeType, bytes: info.size } },
          signal,
        );
      }
      if (
        call.name === "save_project" &&
        input.overwrite !== true &&
        (await exists(join(input.path, "project.json")))
      )
        throw new Error(
          "A project already exists at this destination; set overwrite explicitly to replace it",
        );
      if (call.name === "export_render" && (await exists(input.path)))
        throw new Error("Render destination already exists; choose a new path");
      options.authorize(input.path, false);
    }
    return renderer(call, signal);
  }

  try {
    const server = await startAutomationServer({
      token,
      port: options.port,
      execute,
      cancel,
    });
    return {
      port: server.port,
      status: server.status,
      close: async () => {
        await server.close();
        for (const entry of pending.values()) entry.reject(new Error("Aster automation stopped"));
        pending.clear();
        ipcMain.removeHandler("aster:automation-response");
      },
    };
  } catch (error) {
    ipcMain.removeHandler("aster:automation-response");
    throw error;
  }
}

async function exists(path: string) {
  try {
    await access(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
