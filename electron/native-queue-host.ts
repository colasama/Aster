import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import type { RenderJobManifest, RenderQueueItem } from "../src/core/rendering/render-queue.js";
import type { ResolvePreviewPlugins } from "./native-preview-plugins.js";
import type { PreviewSnapshotRuntime } from "./native-preview-snapshot.js";
import {
  NativeProjectExportCancelled,
  type NativeProjectExportProcess,
} from "./native-project-export-process.js";
import { type NativeQueueExportRuntime, startNativeQueueExport } from "./native-queue-export.js";
import { prepareNativeQueueProject } from "./native-queue-project.js";
import { NativeQueueReporter } from "./native-queue-reporter.js";
import type { RenderMediaAuthorizationLease } from "./render-media-snapshot-store.js";
import type {
  RenderHostReport,
  RenderQueueHostFactory,
  RenderQueueHostHandle,
} from "./render-queue-manager.js";
import { AtomicRenderOutputPublisher } from "./render-queue-output.js";

type OutputProcess = Pick<NativeProjectExportProcess, "completion" | "control" | "dispose">;
interface HostServices {
  prepare: typeof prepareNativeQueueProject;
  start: (options: Parameters<typeof startNativeQueueExport>[0]) => Promise<OutputProcess>;
}
export interface NativeQueueHostOptions {
  temporaryRoot: string;
  runtime: NativeQueueExportRuntime & PreviewSnapshotRuntime;
  authorizeMedia: (manifest: RenderJobManifest) => Promise<RenderMediaAuthorizationLease>;
  resolvePlugins?: ResolvePreviewPlugins;
  onError: (error: unknown) => void;
}

/** Main-process queue execution; native project sessions own evaluation, rendering and encoding. */
export class NativeQueueHostFactory implements RenderQueueHostFactory {
  readonly #workers = new Set<NativeQueueWorker>();
  #closed = false;
  constructor(
    readonly options: NativeQueueHostOptions,
    readonly services: HostServices = {
      prepare: prepareNativeQueueProject,
      start: startNativeQueueExport,
    },
  ) {}

  async launch(
    item: RenderQueueItem,
    leaseId: string,
    report: (event: RenderHostReport) => Promise<void>,
  ): Promise<RenderQueueHostHandle> {
    if (this.#closed) throw new Error("Native queue host is closed");
    const worker = new NativeQueueWorker(
      item.manifest,
      leaseId,
      this.options,
      this.services,
      report,
      () => this.#workers.delete(worker),
    );
    this.#workers.add(worker);
    // The scheduler must install this lease before preparation can emit any reports.
    setImmediate(() => worker.start());
    return worker;
  }

  async dispose(): Promise<void> {
    this.#closed = true;
    await Promise.all([...this.#workers].map((worker) => worker.dispose()));
  }
}

class NativeQueueWorker implements RenderQueueHostHandle {
  readonly jobId: string;
  readonly #manifest: RenderJobManifest;
  readonly #publisher: AtomicRenderOutputPublisher;
  readonly #abort = new AbortController();
  readonly #reporter: NativeQueueReporter;
  readonly #started = performance.now();
  #work?: Promise<"completed" | "cancelled" | "failed">;
  #cleanup?: Promise<void>;
  #lease?: RenderMediaAuthorizationLease;
  #directory?: string;
  #process?: OutputProcess;
  #paused = false;
  #pauseGeneration = 0;
  #acknowledged = -1;
  #wake?: () => void;
  #failure?: unknown;
  #disposed = false;
  #committed = false;

  constructor(
    manifest: RenderJobManifest,
    readonly leaseId: string,
    readonly options: NativeQueueHostOptions,
    readonly services: HostServices,
    readonly report: (event: RenderHostReport) => Promise<void>,
    readonly remove: () => void,
  ) {
    this.#manifest = structuredClone(manifest);
    this.jobId = manifest.id;
    this.#publisher = new AtomicRenderOutputPublisher(this.#manifest, leaseId);
    this.#reporter = new NativeQueueReporter(this.jobId, leaseId, report, (error) =>
      this.#fail(error),
    );
  }

  start(): void {
    if (this.#work) return;
    this.#work = this.#execute().catch((error) => {
      if (this.#failure) return "failed";
      if (this.#abort.signal.aborted || error instanceof NativeProjectExportCancelled)
        return "cancelled";
      this.#failure = error instanceof Error ? error : new Error(String(error));
      return "failed";
    });
    void this.#work
      .then(async (outcome) => {
        try {
          await this.#clean();
        } catch (error) {
          this.options.onError(error);
          if (!this.#committed) {
            this.#failure = error;
            outcome = "failed";
          }
        }
        // Never make execution wait for a terminal callback: the scheduler disposes us inside it.
        await this.#reporter.flush();
        if (this.#disposed) return;
        if (this.#failure && !this.#committed) outcome = "failed";
        await this.report(
          outcome === "failed"
            ? {
                type: "failed",
                jobId: this.jobId,
                leaseId: this.leaseId,
                error: {
                  code: "native_queue_export_failed",
                  message: String(
                    this.#failure instanceof Error ? this.#failure.message : this.#failure,
                  ).slice(0, 2048),
                },
              }
            : { type: outcome, jobId: this.jobId, leaseId: this.leaseId },
        );
      })
      .catch(this.options.onError);
  }

  control(command: "pause" | "resume" | "cancel"): void {
    if (this.#committed) return;
    if (command === "cancel") {
      if (!this.#abort.signal.aborted) this.#abort.abort(new NativeProjectExportCancelled());
      this.#reporter.clearPause();
      this.#process?.control("cancel");
      this.#wake?.();
    } else if (!this.#abort.signal.aborted) {
      if (command === "pause" && !this.#paused) {
        this.#paused = true;
        this.#pauseGeneration++;
        this.#process?.control("pause");
      } else if (command === "resume" && this.#paused) {
        this.#paused = false;
        this.#reporter.clearPause();
        this.#process?.control("resume");
        this.#wake?.();
      }
    }
  }

  async dispose(): Promise<void> {
    this.#disposed = true;
    this.control("cancel");
    this.start();
    await this.#work;
    await this.#clean();
  }

  #fail(error: unknown): void {
    this.#failure ??= error instanceof Error ? error : new Error(String(error));
    this.control("cancel");
  }

  #acknowledgePause(): void {
    const generation = this.#pauseGeneration;
    if (!this.#paused || this.#abort.signal.aborted || this.#acknowledged === generation) return;
    this.#acknowledged = generation;
    this.#reporter.paused(
      () => this.#paused && !this.#abort.signal.aborted && this.#pauseGeneration === generation,
    );
  }

  async #boundary(): Promise<void> {
    this.#abort.signal.throwIfAborted();
    while (this.#paused) {
      this.#acknowledgePause();
      await new Promise<void>((resolve) => {
        this.#wake = resolve;
      });
      this.#wake = undefined;
      this.#abort.signal.throwIfAborted();
    }
  }

  async #execute(): Promise<"completed"> {
    const manifest = this.#manifest,
      signal = this.#abort.signal;
    signal.throwIfAborted();
    this.#lease = await this.options.authorizeMedia(manifest);
    signal.throwIfAborted();
    const root = resolve(this.options.temporaryRoot);
    await mkdir(root, { recursive: true });
    this.#directory = await mkdtemp(join(root, "queue-"));
    await this.#publisher.prepare();
    signal.throwIfAborted();
    const project = await this.services.prepare({
      directory: join(this.#directory, "project"),
      manifest,
      authorizedPaths: this.#lease.nativeMediaPaths ?? [],
      runtime: this.options.runtime,
      resolvePlugins: this.options.resolvePlugins,
    });
    signal.throwIfAborted();
    await this.report({ type: "prepared", jobId: this.jobId, leaseId: this.leaseId });
    const frames = manifest.endFrameExclusive - manifest.startFrame;
    const totalWork = manifest.outputs.reduce(
      (sum, output) => sum + (output.kind === "still" ? 1 : frames),
      0,
    );
    let completedWork = 0;
    for (const [index, output] of manifest.outputs.entries()) {
      await this.#boundary();
      const destination = join(
        this.#directory,
        `output-${index}.${output.kind === "mp4" ? "mp4" : output.kind === "still" ? "png" : "frames"}`,
      );
      const child = await this.services.start({
        manifest,
        prepared: project,
        outputId: output.id,
        destination,
        runtime: this.options.runtime,
        signal,
        onEvent: (event) => {
          if (signal.aborted) return;
          if (event.stage === "paused") this.#acknowledgePause();
          else
            this.#reporter.progress({
              completedFrames: Math.min(
                frames - 1,
                Math.floor(((completedWork + event.rendered_frames) * frames) / totalWork),
              ),
              totalFrames: frames,
              elapsedMs: Math.floor(performance.now() - this.#started),
            });
        },
      });
      this.#process = child;
      if (signal.aborted) child.control("cancel");
      else if (this.#paused) child.control("pause");
      const receipt = await child.completion;
      this.#process = undefined;
      await this.#boundary();
      await this.#publisher.importNativeOutput(output.id, destination, receipt, signal);
      completedWork += output.kind === "still" ? 1 : frames;
    }
    await this.#boundary();
    await this.#publisher.publish(() => signal.aborted || this.#failure !== undefined);
    this.#committed = true;
    return "completed";
  }

  #clean(): Promise<void> {
    this.#cleanup ??= (async () => {
      const errors: unknown[] = [];
      try {
        await this.#process?.dispose().catch((error) => errors.push(error));
        await this.#publisher.cleanup().catch((error) => errors.push(error));
        if (this.#directory)
          await rm(this.#directory, { recursive: true, force: true }).catch((error) =>
            errors.push(error),
          );
      } finally {
        try {
          this.#lease?.dispose();
        } finally {
          this.remove();
        }
      }
      if (errors.length) throw new AggregateError(errors, "Native queue cleanup failed");
    })();
    return this.#cleanup;
  }
}
