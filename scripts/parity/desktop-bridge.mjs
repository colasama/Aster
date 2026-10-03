import { spawn } from "node:child_process";
import { readFile, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { createInterface } from "node:readline";

export class DesktopBridgeClient {
  #child;
  #pending = new Map();
  #nextId = 1;
  #closed = false;
  #timeout;

  constructor(executable, appDataDirectory, options = {}) {
    this.#timeout = options.timeoutMs ?? 120_000;
    this.#child = spawn(executable, options.args ?? ["--app-data-dir", appDataDirectory], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      env: { ...process.env, ...options.env },
    });
    createInterface({ input: this.#child.stdout }).on("line", (line) => {
      try {
        const response = JSON.parse(line);
        if (!Number.isSafeInteger(response.id)) throw new Error("Invalid bridge response id");
        const pending = this.#pending.get(response.id);
        if (!pending) return;
        this.#pending.delete(response.id);
        clearTimeout(pending.timer);
        if (typeof response.error === "string") pending.reject(new Error(response.error));
        else pending.resolve(response.result);
      } catch (error) {
        this.dispose(error);
      }
    });
    createInterface({ input: this.#child.stderr }).on("line", (line) => options.log?.(line));
    this.#child.on("error", (error) => this.dispose(error));
    this.#child.stdin.on("error", (error) => this.dispose(error));
    this.#child.stdout.on("error", (error) => this.dispose(error));
    this.#child.stderr.on("error", (error) => this.dispose(error));
    this.#child.on("exit", (code, signal) => {
      if (!this.#closed) this.dispose(new Error(`Desktop bridge exited: ${signal ?? code}`));
    });
  }

  invoke(command, args = {}) {
    if (this.#closed) return Promise.reject(new Error("Desktop bridge is unavailable"));
    const id = this.#nextId++;
    return new Promise((resolveRequest, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`Desktop bridge ${command} timed out`));
      }, this.#timeout);
      this.#pending.set(id, { resolve: resolveRequest, reject, timer });
      this.#child.stdin.write(`${JSON.stringify({ id, command, args })}\n`, (error) => {
        if (!error) return;
        clearTimeout(timer);
        this.#pending.delete(id);
        reject(error);
      });
    });
  }

  dispose(error = new Error("Desktop bridge stopped")) {
    if (this.#closed) return;
    this.#closed = true;
    this.#child.stdin.destroy();
    this.#child.kill();
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pending.clear();
  }
}

function pathKey(path) {
  const absolute = resolve(path);
  return process.platform === "win32" ? absolute.toLowerCase() : absolute;
}

export class CaptureDesktopAccess {
  #config;
  #client;
  #allowedAssets;
  #assignment;
  #pluginIds = new Set();
  #installed = new Set();

  constructor(config, client, allowedAssets) {
    this.#config = config;
    this.#client = client;
    this.#allowedAssets = allowedAssets;
  }

  async prepare(assignment) {
    if (!this.#config.assignments.includes(assignment))
      throw new Error("Unknown capture assignment");
    this.#assignment = assignment;
    this.#allowedAssets.clear();
    this.#pluginIds.clear();
    for (const source of assignment.case.plugins ?? []) {
      const path = resolve(this.#config.root, source);
      const manifest = await readFile(join(path, "plugin.toml"), "utf8");
      const section = manifest.split(/^\[plugin\]\s*$/m)[1]?.split(/^\[/m)[0];
      const id = /^id\s*=\s*"([^"]+)"/m.exec(section ?? "")?.[1];
      if (!id) throw new Error(`Plugin manifest has no plugin id: ${source}`);
      this.#pluginIds.add(id);
      if (!this.#installed.has(pathKey(path))) {
        await this.#client.invoke("install_plugin", { source: path });
        this.#installed.add(pathKey(path));
      }
    }
  }

  async invoke(command, args = {}) {
    if (!this.#assignment) throw new Error("No capture assignment is active");
    if (!args || typeof args !== "object" || Array.isArray(args))
      throw new Error("Invalid command arguments");
    if (command === "load_project") {
      if (
        typeof args.path !== "string" ||
        pathKey(args.path) !== pathKey(this.#assignment.projectPath)
      ) {
        throw new Error("Project path is outside the active capture assignment");
      }
      const path = await realpath(args.path);
      const info = await stat(path);
      const directory = info.isDirectory() ? path : dirname(path);
      let project;
      if (info.isDirectory()) {
        project = await this.#client.invoke("load_project", { path: directory });
      } else {
        if (!path.toLowerCase().endsWith(".json"))
          throw new Error("Standalone projects must be JSON");
        project = JSON.parse(await readFile(path, "utf8"));
      }
      await this.#authorizeAssets(project, directory);
      return project;
    }
    if (command === "load_plugin_runtime") {
      if (!Array.isArray(args.pluginIds) || args.pluginIds.some((id) => !this.#pluginIds.has(id))) {
        throw new Error("Plugin runtime is outside the active capture assignment");
      }
      return this.#client.invoke(command, { pluginIds: args.pluginIds });
    }
    if (command === "renderer_capabilities") return this.#client.invoke(command, {});
    throw new Error(`Capture desktop command is not permitted: ${command}`);
  }

  async #authorizeAssets(value, directory) {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const entry of value) await this.#authorizeAssets(entry, directory);
      return;
    }
    if (typeof value.relativePath === "string") {
      if (isAbsolute(value.relativePath))
        throw new Error("Relative media path must not be absolute");
      value.resolvedPath = await realpath(resolve(directory, value.relativePath));
    }
    for (const name of ["resolvedPath", "externalPath"]) {
      if (typeof value[name] !== "string") continue;
      const canonical = await realpath(value[name]);
      const displacement = relative(directory, canonical);
      if (
        isAbsolute(displacement) ||
        displacement === ".." ||
        displacement.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)
      ) {
        throw new Error("Media path escapes the assigned project directory");
      }
      this.#allowedAssets.set(pathKey(canonical), canonical);
      this.#allowedAssets.set(pathKey(value[name]), canonical);
      value[name] = canonical;
    }
    for (const entry of Object.values(value)) await this.#authorizeAssets(entry, directory);
  }
}
