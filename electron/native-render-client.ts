import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import {
  NativeReplyReader,
  NativeResourceReplyReader,
  type NativeResourceRequest,
  type NativeSessionCommand,
  type NativeSessionReply,
  sessionControl,
} from "./native-render-protocol.js";

export interface NativeRenderClientOptions {
  executable: string;
  args: readonly string[];
  cwd?: string;
  maxControlBytes?: number;
  maxPayloadBytes?: number;
  requestTimeoutMs?: number;
  closeTimeoutMs?: number;
}

interface PendingReply {
  command: NativeSessionCommand["type"] | "resource_batch";
  reader: Pick<NativeReplyReader, "push">;
  received: boolean;
  resolve(reply: NativeSessionReply): void;
  reject(error: Error): void;
}

/** One transaction at a time: one frame/control, or at most 64 ordered resource operations. */
export class NativeRenderClient {
  readonly #child: ChildProcessWithoutNullStreams;
  readonly #controlLimit: number;
  readonly #payloadLimit: number;
  readonly #timeoutMs: number;
  readonly #closeTimeoutMs: number;
  readonly #exit: Promise<void>;
  #pending?: PendingReply;
  #nextId = 1;
  #failure?: Error;
  #closed = false;
  #shuttingDown = false;
  #stderr = Buffer.alloc(0);

  constructor(options: NativeRenderClientOptions) {
    this.#controlLimit = options.maxControlBytes ?? 65_536;
    this.#payloadLimit = options.maxPayloadBytes ?? 67_108_864;
    this.#timeoutMs = options.requestTimeoutMs ?? 120_000;
    this.#closeTimeoutMs = options.closeTimeoutMs ?? 5_000;
    for (const [value, maximum] of [
      [this.#controlLimit, 65_536],
      [this.#payloadLimit, 67_108_864],
      [this.#timeoutMs, 300_000],
      [this.#closeTimeoutMs, 30_000],
    ])
      if (!Number.isSafeInteger(value) || value < 1 || value > maximum)
        throw new Error("Invalid native sidecar transport limits");
    this.#child = spawn(options.executable, [...options.args], {
      cwd: options.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.#child.stdin.on("error", (error) => this.#fail(error));
    this.#child.stdout.on("error", (error) => this.#fail(error));
    this.#child.stderr.on("error", (error) => this.#fail(error));
    this.#child.stdout.on("data", (chunk: Buffer) => {
      if (this.#failure) return;
      try {
        if (!this.#pending) throw new Error("Native sidecar wrote without a pending request");
        const reply = this.#pending.reader.push(chunk);
        if (reply) {
          this.#pending.received = true;
          this.#pending.resolve(reply);
        }
      } catch (error) {
        this.#fail(error instanceof Error ? error : new Error(String(error)));
      }
    });
    this.#child.stderr.on("data", (chunk: Buffer) => {
      const remaining = 65_536 - this.#stderr.length;
      if (remaining > 0) this.#stderr = Buffer.concat([this.#stderr, chunk.subarray(0, remaining)]);
    });
    this.#exit = new Promise((resolveExit) => {
      this.#child.once("error", (error) => this.#fail(error));
      // close follows drained stdout: an exit event alone can precede the final reply.
      this.#child.once("close", (code, signal) => {
        this.#closed = true;
        if (!this.#shuttingDown || code !== 0 || (this.#pending && !this.#pending.received))
          this.#fail(
            new Error(
              `Native sidecar closed (${signal ?? code}) before a clean shutdown during ${this.#pending?.command ?? "idle"}: ${this.diagnostics}`,
            ),
          );
        resolveExit();
      });
    });
  }

  get diagnostics(): string {
    return this.#stderr.toString("utf8");
  }

  async request(
    command: NativeSessionCommand,
    payload: Uint8Array = new Uint8Array(),
  ): Promise<NativeSessionReply> {
    if (this.#failure) throw this.#failure;
    if (this.#closed || this.#shuttingDown) throw new Error("Native sidecar is closed");
    if (this.#pending) throw new Error("Await the pending native request before sending another");
    command = structuredClone(command);
    const id = this.#nextId;
    const control = sessionControl(id, command, payload, this.#controlLimit, this.#payloadLimit);
    // Coalesce control and binary data while owning inputs before the first asynchronous write.
    const owned = Buffer.concat([
      control,
      Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength),
    ]);
    this.#nextId++;
    if (command.type === "shutdown") this.#shuttingDown = true;
    return this.#exchange(
      command.type,
      new NativeReplyReader(id, command, this.#controlLimit, this.#payloadLimit),
      owned,
    );
  }

  async requestResources(requests: readonly NativeResourceRequest[]): Promise<void> {
    if (this.#failure) throw this.#failure;
    if (this.#closed || this.#shuttingDown) throw new Error("Native sidecar is closed");
    if (this.#pending) throw new Error("Await the pending native request before sending another");
    if (requests.length < 1 || requests.length > 64)
      throw new Error("Native resource batch exceeds count limit");
    const commands = requests.map(({ command }) => {
      if (command.type !== "put_resource" && command.type !== "evict_resource")
        throw new Error("Native resource batch contains a non-resource command");
      return structuredClone(command);
    });
    const buffers: Uint8Array[] = [];
    let payloadBytes = 0;
    for (const [index, command] of commands.entries()) {
      const payload = requests[index].payload ?? new Uint8Array();
      payloadBytes += payload.byteLength;
      if (payloadBytes > this.#payloadLimit)
        throw new Error("Native resource batch exceeds aggregate payload limit");
      buffers.push(
        sessionControl(
          this.#nextId + index,
          command,
          payload,
          this.#controlLimit,
          this.#payloadLimit,
        ),
        payload,
      );
    }
    // One bounded write removes a pipe round-trip per resource without changing the wire protocol.
    const wire = Buffer.concat(buffers);
    const reader = new NativeResourceReplyReader(this.#nextId, commands, this.#controlLimit);
    this.#nextId += commands.length;
    await this.#exchange("resource_batch", reader, wire);
  }

  async #exchange(
    command: PendingReply["command"],
    reader: PendingReply["reader"],
    wire: Buffer,
  ): Promise<NativeSessionReply> {
    const reply = new Promise<NativeSessionReply>((resolve, reject) => {
      this.#pending = {
        command,
        reader,
        received: false,
        resolve,
        reject,
      };
    });
    const timer = setTimeout(
      () => this.#fail(new Error(`Native ${command} request timed out`)),
      this.#timeoutMs,
    );
    try {
      const [result] = await Promise.all([reply, this.#write(wire)]);
      if (this.#failure) throw this.#failure;
      return result;
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      this.#fail(failure);
      throw failure;
    } finally {
      clearTimeout(timer);
      this.#pending = undefined;
    }
  }

  async shutdown(): Promise<void> {
    try {
      await this.request({ type: "shutdown" });
      this.#child.stdin.end();
      await this.#waitForExit();
      if (this.#failure) throw this.#failure;
    } catch (error) {
      await this.dispose();
      throw error;
    }
  }

  /** Out-of-band cancellation interrupts a stalled GPU/encoder call as well as pipe writes. */
  async dispose(): Promise<void> {
    this.#fail(new Error("Native sidecar disposed"));
    await this.#waitForExit();
  }

  #write(bytes: Buffer): Promise<void> {
    return new Promise((resolve, reject) => {
      this.#child.stdin.write(bytes, (error) => (error ? reject(error) : resolve()));
    });
  }

  #fail(error: Error): void {
    if (this.#failure) return;
    this.#failure = error;
    this.#pending?.reject(error);
    this.#child.stdin.destroy();
    if (!this.#closed) this.#child.kill();
  }

  async #waitForExit(): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        this.#exit,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            this.#child.kill("SIGKILL");
            reject(new Error("Native sidecar did not close within its shutdown deadline"));
          }, this.#closeTimeoutMs);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
}
