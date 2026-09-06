import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { type BrowserWindow, clipboard, ipcMain, safeStorage } from "electron";
import type { AutomationSettings } from "../src/desktop/automation-settings.js";
import { replaceFileWithBackup } from "./atomic-file.js";

interface Configuration {
  enabled: boolean;
  port: number;
  token: string;
}
interface Host {
  port: number;
  status(): { clients: number; busy: boolean };
  close(): Promise<void>;
}

/** Owns the local listener and encrypted preferences; secrets never enter renderer state. */
export class AutomationSettingsController {
  #config: Configuration = { enabled: false, port: 48765, token: "" };
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
      adapterPath: string;
      start(config: Configuration): Promise<Host>;
    },
  ) {
    this.#path = join(options.userData, "automation.json");
  }

  async initialize(environment: NodeJS.ProcessEnv = process.env) {
    try {
      if (environment.ASTER_AUTOMATION_TOKEN) {
        this.#environmentManaged = true;
        this.#config = {
          enabled: true,
          port: Number(environment.ASTER_AUTOMATION_PORT ?? 48765),
          token: environment.ASTER_AUTOMATION_TOKEN,
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
          if (
            value.version !== 1 ||
            typeof value.enabled !== "boolean" ||
            typeof value.token !== "string"
          )
            throw new Error("Invalid saved MCP settings");
          this.#config = {
            enabled: value.enabled,
            port: value.port,
            token: safeStorage.decryptString(Buffer.from(value.token, "base64")),
          };
        }
      }
      validate(this.#config);
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
      hasToken: !!this.#config.token,
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
      if (!["enabled", "port", "rotateToken"].includes(key)) throw new Error("Unknown MCP setting");
    if (
      (patch.enabled !== undefined && typeof patch.enabled !== "boolean") ||
      (patch.rotateToken !== undefined && typeof patch.rotateToken !== "boolean")
    )
      throw new Error("Invalid MCP setting value");
    const next: Configuration = {
      enabled: patch.enabled === undefined ? this.#config.enabled : (patch.enabled as boolean),
      port: patch.port === undefined ? this.#config.port : (patch.port as number),
      token:
        patch.rotateToken || !this.#config.token
          ? randomBytes(32).toString("hex")
          : this.#config.token,
    };
    validate(next);
    if (
      !safeStorage.isEncryptionAvailable() ||
      (process.platform === "linux" && safeStorage.getSelectedStorageBackend() === "basic_text")
    )
      throw new Error("Secure system storage is unavailable for the MCP token");
    const document = JSON.stringify(
      {
        version: 1,
        enabled: next.enabled,
        port: next.port,
        token: safeStorage.encryptString(next.token).toString("base64"),
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
    if (kind !== "token" && kind !== "configuration") throw new Error("Unknown MCP copy target");
    if (!this.#config.token) throw new Error("Generate an MCP token first");
    if (this.#pending) throw new Error("MCP settings are busy");
    clipboard.writeText(
      kind === "token"
        ? this.#config.token
        : JSON.stringify(
            {
              mcpServers: {
                aster: {
                  command: this.options.command,
                  args: [this.options.adapterPath],
                  env: {
                    ELECTRON_RUN_AS_NODE: "1",
                    ASTER_AUTOMATION_PORT: String(this.#host?.port ?? this.#config.port),
                    ASTER_AUTOMATION_TOKEN: this.#config.token,
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

function validate(config: Configuration) {
  if (!Number.isSafeInteger(config.port) || config.port < 1 || config.port > 65535)
    throw new Error("MCP port must be an integer from 1 to 65535");
  if ((config.enabled || config.token) && (config.token.length < 32 || config.token.length > 4096))
    throw new Error("MCP token must contain 32 to 4096 characters");
}
function message(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
