import assert from "node:assert/strict";
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { open, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { renderPathKey } from "./render-queue-paths.js";

/** Read-only project and asset scope for a single native raster job. */
export class NativeRasterProject {
  readonly allowedAssets = new Map<string, string>();
  #child?: ChildProcessWithoutNullStreams;
  #loaded?: Promise<unknown>;
  #reject?: (error: Error) => void;
  constructor(
    readonly project: string,
    readonly sha256: string,
    readonly bridge: string,
    readonly profile: string,
    readonly maximumBytes: number,
  ) {}

  invoke(command: string, args: Record<string, unknown>) {
    if (
      command !== "load_project" ||
      typeof args?.path !== "string" ||
      renderPathKey(args.path) !== renderPathKey(this.project)
    )
      return Promise.reject(new Error("Raster project command is outside the admitted scope"));
    this.#loaded ??= this.#load();
    return this.#loaded;
  }

  async #load() {
    const path = await realpath(this.project),
      directory = (await stat(path)).isDirectory();
    const file = await open(directory ? join(path, "project.json") : path, "r");
    let bytes: Buffer;
    try {
      const info = await file.stat();
      assert(info.isFile() && info.size <= this.maximumBytes, "Raster project exceeds byte budget");
      bytes = Buffer.alloc(info.size + 1);
      let used = 0;
      while (used < bytes.length) {
        const read = await file.read(bytes, used, bytes.length - used, null);
        if (!read.bytesRead) break;
        used += read.bytesRead;
      }
      assert(used <= info.size, "Raster project changed during load");
      bytes = bytes.subarray(0, used);
    } finally {
      await file.close();
    }
    assert.equal(createHash("sha256").update(bytes).digest("hex"), this.sha256);
    const project: unknown = directory
      ? await this.#loadBundle(path)
      : JSON.parse(bytes.toString("utf8"));
    this.#retainRasterImports(project);
    await this.#authorize(project, directory ? path : dirname(path), 0, { nodes: 0 });
    return project;
  }

  #retainRasterImports(value: unknown) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return;
    const document = value as Record<string, unknown>;
    const imports = document.mediaImports as
      | { version?: unknown; entries?: unknown; payloads?: unknown }
      | undefined;
    if (!imports) return;
    assert(
      imports.version === 1 && Array.isArray(imports.entries) && Array.isArray(imports.payloads),
      "Invalid raster project media catalog",
    );
    // Rust owns footage decoding. The isolated browser only hydrates retained SVG/PSD pixels;
    // admitting native sequence containers here would duplicate I/O and impose save-file limits.
    const entries = imports.entries.filter(
      (entry: { kind?: string }) => entry?.kind === "svg" || entry?.kind === "psd",
    );
    const payloads = new Set(entries.map((entry) => entry.payloadId));
    document.mediaImports = {
      ...imports,
      entries,
      payloads: imports.payloads.filter((payload: { id?: string }) => payloads.has(payload?.id)),
    };
  }

  #loadBundle(path: string): Promise<unknown> {
    const child = spawn(this.bridge, ["--app-data-dir", this.profile], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.#child = child;
    child.stderr.resume();
    return new Promise((resolveLoad, reject) => {
      let data = Buffer.alloc(0),
        settled = false;
      const finish = (error?: Error, value?: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.#reject = undefined;
        if (error) reject(error);
        else resolveLoad(value);
      };
      this.#reject = (error) => finish(error);
      const timer = setTimeout(
        () => finish(new Error("Raster project loading timed out")),
        120_000,
      );
      child.on("error", (error) => finish(error));
      child.on("close", () => finish(new Error("Raster project bridge exited")));
      child.stdin.on("error", (error) => finish(error));
      child.stdout.on("error", (error) => finish(error));
      child.stdout.on("data", (chunk: Buffer) => {
        if (settled) return;
        if (data.length + chunk.length > this.maximumBytes) {
          finish(new Error("Raster project response exceeds byte budget"));
          return;
        }
        data = Buffer.concat([data, chunk]);
        const end = data.indexOf(10);
        if (end < 0) return;
        try {
          const message = JSON.parse(data.subarray(0, end).toString("utf8"));
          assert.equal(message.id, 1);
          if (message.error) throw new Error(String(message.error));
          finish(undefined, message.result);
        } catch (error) {
          finish(error instanceof Error ? error : new Error(String(error)));
        }
      });
      child.stdin.end(`${JSON.stringify({ id: 1, command: "load_project", args: { path } })}\n`);
    });
  }

  async #authorize(value: unknown, directory: string, depth: number, budget: { nodes: number }) {
    assert(depth <= 128 && ++budget.nodes <= 2_000_000, "Raster project object budget exceeded");
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const member of value) await this.#authorize(member, directory, depth + 1, budget);
      return;
    }
    const object = value as Record<string, unknown>;
    if (typeof object.relativePath === "string") {
      assert(!isAbsolute(object.relativePath), "Relative raster asset must not be absolute");
      object.resolvedPath = await realpath(resolve(directory, object.relativePath));
    }
    for (const name of ["resolvedPath", "externalPath"]) {
      if (typeof object[name] !== "string") continue;
      const canonical = await realpath(object[name]);
      const displacement = relative(directory, canonical);
      assert(
        !isAbsolute(displacement) && displacement !== ".." && !displacement.startsWith(`..${sep}`),
        "Raster asset escapes the admitted project",
      );
      this.allowedAssets.set(renderPathKey(canonical), canonical);
      this.allowedAssets.set(renderPathKey(object[name]), canonical);
      object[name] = canonical;
    }
    for (const member of Object.values(object))
      await this.#authorize(member, directory, depth + 1, budget);
  }

  dispose() {
    this.#reject?.(new Error("Raster project closed"));
    this.#child?.stdin.destroy();
    this.#child?.kill();
    this.#child = undefined;
    this.allowedAssets.clear();
  }
}
