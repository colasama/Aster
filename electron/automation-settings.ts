import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { type BrowserWindow, clipboard, ipcMain } from "electron";
import type { AutomationSettings } from "../src/desktop/automation-settings.js";
import { replaceFileWithBackup } from "./atomic-file.js";

interface Configuration {
  enabled: boolean;
  port: number;
}
interface Host {
  port: number;
  status(): { clients: number; busy: boolean };
  close(): Promise<void>;
}

/** Owns the opt-in loopback listener and its persisted startup preference. */
export class AutomationSettingsController {
  #config: Configuration = { enabled: false, port: 48765 };
  #host?: Host;
  #error?: string;
  #environmentManaged = false;
  #pending?: Promise<AutomationSettings>;
  #closing = false;
  readonly #path: string;

  constructor(
    readonly options: {
      userData: string;
      command: string;
      launchArgs: string[];
      nodeMode?: boolean;
      start(config: Configuration): Promise<Host>;
    },
  ) {
    this.#path = join(options.userData, "automation.json");
  }

  async initialize(environment: NodeJS.ProcessEnv = process.env) {
    try {
      if (environment.ASTER_AUTOMATION_ENABLED !== undefined) {
        this.#environmentManaged = true;
        this.#config = {
          enabled: environment.ASTER_AUTOMATION_ENABLED === "1",
          port: Number(environment.ASTER_AUTOMATION_PORT ?? 48765),
        };
      } else {
        let raw: string | undefined;
        try {
          raw = await readFile(this.#path, "utf8");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        if (raw) {
          const value = JSON.parse(raw);
          if (![1, 2].includes(value.version) || typeof value.enabled !== "boolean")
            throw new Error("Invalid saved MCP settings");
          this.#config = {
            enabled: value.enabled,
            port: value.port,
          };
        }
      }
      validate(this.#config, this.#environmentManaged);
      if (this.#config.enabled) this.#host = await this.options.start(this.#config);
    } catch (error) {
      this.#error = message(error);
    }
    return this.snapshot();
  }

  snapshot(): AutomationSettings {
    return {
      enabled: this.#config.enabled,
      port: this.#host?.port ?? this.#config.port,
      running: !!this.#host,
      clients: this.#host?.status().clients ?? 0,
      busy: !!this.#pending || (this.#host?.status().busy ?? false),
      environmentManaged: this.#environmentManaged,
      ...(this.#error ? { error: this.#error } : {}),
    };
  }

  async update(input: unknown): Promise<AutomationSettings> {
    if (this.#environmentManaged)
      throw new Error("MCP is controlled by startup environment variables");
    if (this.#pending || this.#closing) throw new Error("MCP settings are busy");
    if (!input || typeof input !== "object" || Array.isArray(input))
      throw new Error("Invalid MCP settings");
    const patch = input as Record<string, unknown>;
    for (const key of Object.keys(patch))
      if (!["enabled", "port"].includes(key)) throw new Error("Unknown MCP setting");
    if (patch.enabled !== undefined && typeof patch.enabled !== "boolean")
      throw new Error("Invalid MCP setting value");
    const next: Configuration = {
      enabled: patch.enabled === undefined ? this.#config.enabled : (patch.enabled as boolean),
      port: patch.port === undefined ? this.#config.port : (patch.port as number),
    };
    validate(next);
    const document = JSON.stringify(
      {
        version: 2,
        enabled: next.enabled,
        port: next.port,
      },
      null,
      2,
    );
    this.#pending = this.#apply(next, document);
    try {
      await this.#pending;
    } finally {
      this.#pending = undefined;
    }
    return this.snapshot();
  }

  async #apply(next: Configuration, document: string): Promise<AutomationSettings> {
    const previous = this.#config;
    const wasRunning = !!this.#host;
    await this.#host?.close();
    this.#host = undefined;
    try {
      if (next.enabled) this.#host = await this.options.start(next);
      await replaceFileWithBackup(
        this.#path,
        `${this.#path}.tmp`,
        `${this.#path}.backup`,
        document,
      );
      this.#config = next;
      this.#error = undefined;
    } catch (error) {
      await this.#host?.close();
      this.#host = undefined;
      if (wasRunning) {
        try {
          this.#host = await this.options.start(previous);
        } catch (restoreError) {
          this.#error = message(restoreError);
        }
      }
      throw error;
    }
    return this.snapshot();
  }

  copy(kind: unknown) {
    if (kind !== "configuration") throw new Error("Unknown MCP copy target");
    if (this.#pending) throw new Error("MCP settings are busy");
    clipboard.writeText(
      JSON.stringify(
        {
          mcpServers: {
            aster: {
              command: this.options.command,
              args: this.options.launchArgs,
              env: {
                ...(this.options.nodeMode ? { ELECTRON_RUN_AS_NODE: "1" } : {}),
                ASTER_AUTOMATION_PORT: String(this.#host?.port ?? this.#config.port),
              },
            },
          },
        },
        null,
        2,
      ),
    );
  }

  registerIpc(window: () => BrowserWindow | undefined) {
    const assertOwner = (event: Electron.IpcMainInvokeEvent) => {
      const contents = window()?.webContents;
      if (!contents || event.sender !== contents || event.senderFrame !== contents.mainFrame)
        throw new Error("MCP settings require the primary editor window");
    };
    ipcMain.handle("aster:automation-settings-get", (event) => {
      assertOwner(event);
      return this.snapshot();
    });
    ipcMain.handle("aster:automation-settings-update", (event, input: unknown) => {
      assertOwner(event);
      return this.update(input);
    });
    ipcMain.handle("aster:automation-settings-copy", (event, kind: unknown) => {
      assertOwner(event);
      this.copy(kind);
    });
  }

  async close() {
    this.#closing = true;
    await this.#pending?.catch(() => undefined);
    await this.#host?.close();
    this.#host = undefined;
  }
}

function validate(config: Configuration, allowDynamicPort = false) {
  if (
    !Number.isSafeInteger(config.port) ||
    config.port < (allowDynamicPort ? 0 : 1) ||
    config.port > 65535
  )
    throw new Error("MCP port must be an integer from 1 to 65535");
}
function message(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
