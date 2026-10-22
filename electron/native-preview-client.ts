import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";

export type NativePreviewSource =
  | { kind: "plan"; sha256: string }
  | {
      kind: "project";
      authored_sha256: string;
      runtime_sha256: string;
      scope: string;
      revision: number;
      composition_id: string;
    };
export interface NativePreviewReady {
  type: "ready";
  schema_version: 1;
  generation: number;
  width: number;
  height: number;
  slots: number;
  source: NativePreviewSource;
  adapter: Record<string, unknown>;
}
export interface NativePreviewFrame {
  type: "frame";
  sequence: number;
  generation: number;
  time: number | null;
  nt_handle: number[];
  render_and_share_ms: number;
  timings?: { prepare_ms: number; raster_ms: number; render_ms: number; share_ms: number };
}
type Reply =
  | NativePreviewReady
  | NativePreviewFrame
  | { type: "released"; sequence: number }
  | { type: "stopped" };
interface Pending {
  resolve(value: Reply): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

/** A bounded control lane. Pixels never cross this pipe and handles never reach renderer IPC. */
export class NativePreviewClient {
  readonly ready: Promise<NativePreviewReady>;
  readonly #child: ChildProcessWithoutNullStreams;
  readonly #timeout: number;
  readonly #exit: Promise<void>;
  readonly #leases = new Set<number>();
  #pending?: Pending;
  #current?: NativePreviewReady;
  #bytes = Buffer.alloc(0);
  #failure?: Error;
  #stopping = false;
  #closed = false;
  #sequence = 0;
  #queued = 0;
  #tail: Promise<unknown> = Promise.resolve();
  #stderr = "";

  constructor(options: {
    executable: string;
    args: readonly string[];
    cwd?: string;
    timeoutMs?: number;
  }) {
    this.#timeout = options.timeoutMs ?? 120000;
    if (!Number.isSafeInteger(this.#timeout) || this.#timeout < 1 || this.#timeout > 300000)
      throw new Error("Invalid preview timeout");
    this.#child = spawn(
      options.executable,
      [...options.args, "--consumer-pid", String(process.pid)],
      { cwd: options.cwd, stdio: ["pipe", "pipe", "pipe"], windowsHide: true },
    );
    this.ready = this.#receive()
      .then((value) => this.#acceptReady(value, 1))
      .catch((error: unknown) => {
        this.#fail(error);
        throw error;
      });
    this.#child.stdout.on("data", (chunk: Buffer) => {
      if (this.#failure) return;
      try {
        if (!this.#pending || this.#bytes.length + chunk.length > 65536)
          throw new Error("Unsolicited or oversized native preview reply");
        this.#bytes = Buffer.concat([this.#bytes, chunk]);
        const end = this.#bytes.indexOf(10);
        if (end < 0) return;
        if (end !== this.#bytes.length - 1) throw new Error("Extra native preview reply bytes");
        const value: unknown = JSON.parse(this.#bytes.subarray(0, end).toString("utf8"));
        this.#bytes = Buffer.alloc(0);
        if (!value || typeof value !== "object" || !("type" in value))
          throw new Error(`Native preview rejected the request: ${JSON.stringify(value)}`);
        const pending = this.#pending;
        this.#pending = undefined;
        clearTimeout(pending.timer);
        pending.resolve(value as Reply);
      } catch (error) {
        this.#fail(error);
      }
    });
    for (const stream of [this.#child.stdin, this.#child.stdout, this.#child.stderr])
      stream.on("error", (error) => this.#fail(error));
    this.#child.stderr.on("data", (chunk: Buffer) => {
      this.#stderr = (this.#stderr + chunk.toString("utf8")).slice(-16384);
    });
    this.#child.on("error", (error) => this.#fail(error));
    this.#exit = new Promise((resolve) =>
      this.#child.once("close", (code) => {
        this.#closed = true;
        if (!this.#stopping || code !== 0 || this.#pending)
          this.#fail(new Error(`Native preview exited (${code}): ${this.#stderr}`));
        resolve();
      }),
    );
  }

  get current(): NativePreviewReady {
    if (!this.#current) throw new Error("Native preview is not ready");
    return this.#current;
  }

  #acceptReady(value: Reply, generation: number): NativePreviewReady {
    const source = value.type === "ready" ? value.source : undefined;
    const validSource =
      source &&
      typeof source === "object" &&
      !Array.isArray(source) &&
      (source.kind === "plan"
        ? typeof source.sha256 === "string" && /^[a-f0-9]{64}$/.test(source.sha256)
        : source.kind === "project" &&
          [source.authored_sha256, source.runtime_sha256].every(
            (hash) => typeof hash === "string" && /^[a-f0-9]{64}$/.test(hash),
          ) &&
          [source.scope, source.composition_id].every(
            (id) => typeof id === "string" && id.length > 0 && id.length <= 4096,
          ) &&
          Number.isSafeInteger(source.revision) &&
          source.revision >= 0);
    if (
      value.type !== "ready" ||
      value.schema_version !== 1 ||
      value.generation !== generation ||
      ![value.width, value.height].every((v) => Number.isSafeInteger(v) && v > 0 && v <= 16384) ||
      !Number.isSafeInteger(value.slots) ||
      value.slots < 1 ||
      value.slots > 3 ||
      !validSource ||
      !value.adapter ||
      typeof value.adapter !== "object"
    )
      throw new Error("Invalid native preview readiness");
    this.#current = Object.freeze({
      ...value,
      source: Object.freeze({ ...value.source }),
      adapter: Object.freeze({ ...value.adapter }),
    });
    return this.#current;
  }

  replace(project: string, request: string): Promise<NativePreviewReady> {
    return this.#enqueue(async () => {
      await this.ready;
      if (this.current.source.kind !== "project")
        throw new Error("Fixed plan cannot replace its source");
      if (this.#leases.size) throw new Error("Drain GPU references before replacing preview");
      const generation = this.current.generation + 1;
      if (
        !Number.isSafeInteger(generation) ||
        ![project, request].every(
          (path) =>
            typeof path === "string" &&
            path.length > 0 &&
            path.length <= 16384 &&
            !path.includes("\0"),
        )
      )
        throw new Error("Invalid preview replacement");
      try {
        return this.#acceptReady(
          await this.#exchange({ type: "replace", generation, project, request }),
          generation,
        );
      } catch (error) {
        throw this.#fail(error);
      }
    });
  }

  present(time?: number): Promise<NativePreviewFrame> {
    return this.#enqueue(async () => {
      await this.ready;
      const ready = this.current;
      if (ready.source.kind === "plan" ? time !== undefined : !Number.isFinite(time))
        throw new Error("Preview time is incompatible with its immutable source");
      if (this.#leases.size >= ready.slots) throw new Error("Preview surface leases exhausted");
      if (!Number.isSafeInteger(this.#sequence + 1)) throw new Error("Preview sequence exhausted");
      const sequence = ++this.#sequence;
      const reply = await this.#exchange({
        type: "present",
        sequence,
        generation: ready.generation,
        time,
      });
      if (
        reply.type !== "frame" ||
        reply.sequence !== sequence ||
        reply.generation !== ready.generation ||
        reply.time !== (time ?? null) ||
        !Array.isArray(reply.nt_handle) ||
        reply.nt_handle.length !== 8 ||
        !reply.nt_handle.every((v) => Number.isInteger(v) && v >= 0 && v <= 255) ||
        !reply.nt_handle.some((v) => v !== 0) ||
        !Number.isFinite(reply.render_and_share_ms) ||
        reply.render_and_share_ms < 0
      )
        throw this.#fail(new Error("Invalid native preview frame identity"));
      this.#leases.add(sequence);
      return reply;
    });
  }

  release(sequence: number): Promise<void> {
    return this.#enqueue(async () => {
      if (!this.#leases.has(sequence)) throw new Error("Unknown preview surface lease");
      const reply = await this.#exchange({ type: "release", sequence });
      if (reply.type !== "released" || reply.sequence !== sequence)
        throw this.#fail(new Error("Preview release acknowledgement differs"));
      this.#leases.delete(sequence);
    });
  }

  async close(): Promise<void> {
    await this.#enqueue(async () => {
      await this.ready;
      if (this.#leases.size) throw new Error("Drain GPU references before closing preview");
      this.#stopping = true;
      const reply = await this.#exchange({ type: "shutdown" });
      if (reply.type !== "stopped")
        throw this.#fail(new Error("Native preview shutdown was not acknowledged"));
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        this.#exit,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("Native preview did not exit")), 5000);
        }),
      ]);
      if (this.#failure) throw this.#failure;
    } catch (error) {
      this.#fail(error);
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  abort(reason: string): void {
    this.#fail(new Error(reason));
  }

  #enqueue<T>(run: () => Promise<T>): Promise<T> {
    if (this.#failure) return Promise.reject(this.#failure);
    if (this.#closed || this.#stopping || this.#queued >= 8)
      return Promise.reject(new Error("Native preview is closed or its control queue is full"));
    this.#queued++;
    const pending = this.#tail
      .then(async () => {
        if (this.#failure) throw this.#failure;
        return run();
      })
      .finally(() => {
        this.#queued--;
      });
    this.#tail = pending.catch(() => undefined);
    return pending;
  }

  #receive(): Promise<Reply> {
    return new Promise((resolve, reject) => {
      if (this.#pending) return reject(new Error("Preview control lane is already occupied"));
      const timer = setTimeout(
        () => this.#fail(new Error("Native preview reply timed out")),
        this.#timeout,
      );
      this.#pending = { resolve, reject, timer };
    });
  }

  #exchange(command: {
    type: string;
    sequence?: number;
    generation?: number;
    time?: number;
    project?: string;
    request?: string;
  }): Promise<Reply> {
    if (this.#failure) return Promise.reject(this.#failure);
    const reply = this.#receive();
    this.#child.stdin.write(`${JSON.stringify(command)}\n`, (error) => {
      if (error) this.#fail(error);
    });
    return reply;
  }

  #fail(error: unknown): Error {
    const first = !this.#failure;
    this.#failure ??= error instanceof Error ? error : new Error(String(error));
    if (this.#pending) {
      clearTimeout(this.#pending.timer);
      this.#pending.reject(this.#failure);
      this.#pending = undefined;
    }
    if (first && !this.#closed) {
      // EOF unwinds Rust-owned remote handles even when frames are still leased.
      // No slot is reused after failure; Chromium retains its own resource references.
      this.#child.stdin.end();
      const timer = setTimeout(() => this.#child.kill(), 5000);
      timer.unref();
      void this.#exit?.then(() => clearTimeout(timer));
    }
    return this.#failure;
  }
}
