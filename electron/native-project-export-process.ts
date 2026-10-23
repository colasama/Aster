import { type ChildProcessWithoutNullStreams, execFile, spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import {
  type NativeProjectExportExpectation,
  type NativeProjectExportProgress,
  type NativeProjectExportReceipt,
  parseNativeProjectProgress,
  parseNativeProjectReceipt,
  validateNativeProjectExpectation,
} from "./native-project-export-protocol.js";

export class NativeProjectExportCancelled extends Error {
  constructor() {
    super("Native project export cancelled");
    this.name = "NativeProjectExportCancelled";
  }
}

export type NativeProjectExportEvent =
  | NativeProjectExportProgress
  | { stage: "paused"; request_id: number };

/** One child owns one native output; completion settles only after all process pipes close. */
export class NativeProjectExportProcess {
  readonly completion: Promise<NativeProjectExportReceipt>;
  readonly #child: ChildProcessWithoutNullStreams;
  readonly #expected: NativeProjectExportExpectation;
  readonly #event: (value: NativeProjectExportEvent) => void;
  readonly #decoder = new StringDecoder("utf8");
  #line = "";
  #stderr = "";
  #receipt?: NativeProjectExportReceipt;
  #error?: Error;
  #closed = false;
  #cancelled = false;
  #pauseId = 0;
  #pendingPause?: number;
  #rendered = 0;
  #elapsed = 0;
  #killTimer?: ReturnType<typeof setTimeout>;

  constructor(options: {
    executable: string;
    args: readonly string[];
    expected: NativeProjectExportExpectation;
    onEvent?: (value: NativeProjectExportEvent) => void;
    env?: NodeJS.ProcessEnv;
  }) {
    validateNativeProjectExpectation(options.expected);
    this.#expected = structuredClone(options.expected);
    this.#event = options.onEvent ?? (() => {});
    this.#child = spawn(options.executable, [...options.args], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      detached: process.platform !== "win32",
      env: options.env,
    });
    this.completion = new Promise((resolve, reject) => {
      this.#child.once("error", (error) => this.#abort(error));
      this.#child.stdin.on("error", (error) => {
        if (!this.#cancelled && !this.#receipt) this.#abort(error);
      });
      this.#child.stdout.on("error", (error) => this.#abort(error));
      this.#child.stderr.on("error", (error) => this.#abort(error));
      this.#child.stdout.on("data", (chunk: Buffer) => {
        if (this.#error || this.#cancelled) return;
        try {
          this.#consume(this.#decoder.write(chunk));
        } catch (error) {
          this.#abort(error instanceof Error ? error : new Error(String(error)));
        }
      });
      this.#child.stderr.on("data", (chunk: Buffer) => {
        this.#stderr = (this.#stderr + chunk.toString("utf8")).slice(-65536);
      });
      this.#child.once("close", (code, signal) => {
        this.#closed = true;
        clearTimeout(this.#killTimer);
        if (!this.#error && !this.#cancelled) {
          try {
            this.#consume(this.#decoder.end());
            if (this.#line.trim()) throw new Error("Truncated native export receipt");
            if (code !== 0 || signal || !this.#receipt || this.#rendered !== this.#expected.frames)
              throw new Error(
                `Native export did not complete (${code ?? signal}): ${this.#stderr}`,
              );
          } catch (error) {
            this.#error = error instanceof Error ? error : new Error(String(error));
          }
        }
        if (this.#error) reject(this.#error);
        else if (this.#cancelled) reject(new NativeProjectExportCancelled());
        else if (this.#receipt) resolve(this.#receipt);
        else reject(new Error("Native export has no completion receipt"));
      });
    });
    // The owner may install its terminal handler after preparation; retain the rejection for it.
    void this.completion.catch(() => {});
  }

  control(action: "pause" | "resume" | "cancel"): void {
    if (this.#closed || this.#cancelled || this.#error) return;
    if (action === "cancel") {
      this.#cancelled = true;
      this.#pendingPause = undefined;
      this.#write({ action });
      this.#armTermination();
    } else if (action === "pause") {
      this.#pendingPause = ++this.#pauseId;
      this.#write({ action, request_id: this.#pendingPause });
    } else {
      this.#pendingPause = undefined;
      this.#write({ action });
    }
  }

  async dispose(): Promise<void> {
    this.control("cancel");
    await this.completion.catch(() => {});
  }

  #write(value: { action: string; request_id?: number }): void {
    if (this.#child.stdin.destroyed) return;
    if (this.#child.stdin.writableLength > 65536) {
      this.#abort(new Error("Native export control queue exceeded its bound"));
      return;
    }
    this.#child.stdin.write(`${JSON.stringify(value)}\n`);
  }

  #consume(text: string): void {
    this.#line += text;
    let end = this.#line.indexOf("\n");
    while (end >= 0) {
      if (end > 67108864) throw new Error("Native export receipt exceeds its bound");
      const line = this.#line.slice(0, end).trim();
      this.#line = this.#line.slice(end + 1);
      if (line) this.#row(JSON.parse(line));
      end = this.#line.indexOf("\n");
    }
    if (this.#line.length > 67108864) throw new Error("Native export receipt exceeds its bound");
  }

  #row(value: unknown): void {
    if (this.#cancelled || this.#error) return;
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error("Invalid native export message");
    const row = value as Record<string, unknown>;
    if (this.#receipt) throw new Error("Native export sent data after completion");
    if (row.stage === "paused") {
      if (Number.isSafeInteger(row.request_id) && row.request_id === this.#pendingPause) {
        this.#pendingPause = undefined;
        this.#event({ stage: "paused", request_id: Number(row.request_id) });
      }
    } else if (row.stage) {
      const progress = parseNativeProjectProgress(row, this.#expected);
      if (progress.rendered_frames < this.#rendered || progress.elapsed_ms < this.#elapsed)
        throw new Error("Native export progress moved backwards");
      this.#rendered = progress.rendered_frames;
      this.#elapsed = progress.elapsed_ms;
      this.#event(progress);
    } else if (row.status === "passed") {
      this.#receipt = parseNativeProjectReceipt(row, this.#expected);
    } else {
      throw new Error(
        typeof row.error === "string" ? row.error.slice(0, 8192) : "Unknown native export message",
      );
    }
  }

  #abort(error: Error): void {
    if (this.#closed || this.#error) return;
    this.#error = error;
    this.#pendingPause = undefined;
    this.#child.stdin.end('{"action":"cancel"}\n');
    this.#armTermination();
  }

  #armTermination(): void {
    if (this.#killTimer) return;
    this.#killTimer = setTimeout(() => {
      const pid = this.#child.pid;
      if (this.#closed || !pid) return;
      if (process.platform === "win32") {
        execFile(
          "taskkill.exe",
          ["/PID", String(pid), "/T", "/F"],
          { windowsHide: true, timeout: 5000 },
          (error) => {
            if (error && !this.#closed) this.#child.kill();
          },
        );
      } else {
        try {
          process.kill(-pid, "SIGKILL");
        } catch {
          this.#child.kill("SIGKILL");
        }
      }
    }, 30000);
    this.#killTimer.unref();
  }
}
