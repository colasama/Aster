import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { BrowserWindow, ipcMain } from "electron";
import type {
  RenderJobManifest,
  RenderOutputModule,
  RenderQueueItem,
} from "../src/core/render-queue.js";
import type { AsterLogger } from "./logger.js";
import { Mp4ExportManager } from "./mp4-export.js";
import { prepareAuthorizedRenderHost } from "./render-host-launch-barrier.js";
import type { RenderMediaAuthorizationLease } from "./render-media-snapshot-store.js";
import { parseRenderHostOutputRequest } from "./render-queue-host-protocol.js";
import type {
  RenderHostReport,
  RenderQueueHostFactory,
  RenderQueueHostHandle,
} from "./render-queue-manager.js";
import { parseRenderHostReport } from "./render-queue-manager.js";
import { AtomicRenderOutputPublisher } from "./render-queue-output.js";

export interface ElectronRenderHostControllerOptions {
  appPath: string;
  developmentUrl: string;
  ffmpegExecutable: string;
  logger: AsterLogger;
  authorizeMedia?: (manifest: RenderJobManifest) => Promise<RenderMediaAuthorizationLease>;
  packaged: boolean;
}

export interface RenderHostAssignment {
  jobId: string;
  leaseId: string;
  manifest: RenderQueueItem["manifest"];
  initialControl?: "pause" | "cancel";
}

/** Owns sandboxed hidden renderer windows and authorizes their lease-correlated IPC. */
export class ElectronRenderHostController implements RenderQueueHostFactory {
  readonly #options: ElectronRenderHostControllerOptions;
  readonly #workers = new Map<number, ElectronRenderHostWorker>();
  #registered = false;

  constructor(options: ElectronRenderHostControllerOptions) {
    this.#options = options;
  }

  registerIpc(): void {
    if (this.#registered) throw new Error("RenderHost IPC is already registered");
    this.#registered = true;
    ipcMain.handle("aster:render-host-take", (event) => this.#worker(event.sender.id).take());
    ipcMain.handle("aster:render-host-output", (event, value: unknown) =>
      this.#worker(event.sender.id).output(value),
    );
    ipcMain.handle("aster:render-host-report", (event, value: unknown) =>
      this.#worker(event.sender.id).hostReport(value),
    );
  }

  isRenderHost(senderId: number): boolean {
    return this.#workers.has(senderId);
  }

  async launch(
    item: RenderQueueItem,
    leaseId: string,
    report: (event: RenderHostReport) => Promise<void>,
  ): Promise<RenderQueueHostHandle> {
    const publisher = new AtomicRenderOutputPublisher(item.manifest, leaseId);
    const mediaAuthorization = await prepareAuthorizedRenderHost(
      this.#options.authorizeMedia
        ? () => {
            const authorizeMedia = this.#options.authorizeMedia;
            if (!authorizeMedia) throw new Error("Render media authorization is unavailable");
            return authorizeMedia(item.manifest);
          }
        : undefined,
      () => publisher.prepare(),
      (authorization) => authorization.dispose(),
    );
    let window: BrowserWindow;
    try {
      window = new BrowserWindow({
        show: false,
        skipTaskbar: true,
        paintWhenInitiallyHidden: true,
        width: 64,
        height: 64,
        backgroundColor: "#000000",
        webPreferences: {
          preload: join(dirname(fileURLToPath(import.meta.url)), "render-host-preload.cjs"),
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
          webSecurity: true,
          spellcheck: false,
          backgroundThrottling: false,
        },
      });
    } catch (error) {
      await publisher.cleanup();
      mediaAuthorization?.dispose();
      throw error;
    }
    const senderId = window.webContents.id;
    const worker = new ElectronRenderHostWorker({
      window,
      item,
      leaseId,
      publisher,
      mediaAuthorization,
      report,
      ffmpegExecutable: this.#options.ffmpegExecutable,
      logger: this.#options.logger,
      remove: () => this.#workers.delete(senderId),
    });
    this.#workers.set(senderId, worker);
    queueMicrotask(() =>
      worker.startLoading({
        appPath: this.#options.appPath,
        developmentUrl: this.#options.developmentUrl,
        packaged: this.#options.packaged,
      }),
    );
    return worker;
  }

  async dispose(): Promise<void> {
    const workers = [...this.#workers.values()];
    this.#workers.clear();
    await Promise.allSettled(workers.map((worker) => worker.dispose()));
    if (this.#registered) {
      ipcMain.removeHandler("aster:render-host-take");
      ipcMain.removeHandler("aster:render-host-output");
      ipcMain.removeHandler("aster:render-host-report");
      this.#registered = false;
    }
  }

  #worker(senderId: number): ElectronRenderHostWorker {
    const worker = this.#workers.get(senderId);
    if (!worker) throw new Error("RenderHost IPC sender is not an active hidden render host");
    return worker;
  }
}

interface WorkerOptions {
  window: BrowserWindow;
  item: RenderQueueItem;
  leaseId: string;
  publisher: AtomicRenderOutputPublisher;
  mediaAuthorization?: RenderMediaAuthorizationLease;
  report: (event: RenderHostReport) => Promise<void>;
  ffmpegExecutable: string;
  logger: AsterLogger;
  remove: () => void;
}

class ElectronRenderHostWorker implements RenderQueueHostHandle {
  readonly jobId: string;
  readonly leaseId: string;
  readonly #window: BrowserWindow;
  readonly #item: RenderQueueItem;
  readonly #publisher: AtomicRenderOutputPublisher;
  readonly #mediaAuthorization?: RenderMediaAuthorizationLease;
  readonly #report: (event: RenderHostReport) => Promise<void>;
  readonly #ffmpegExecutable: string;
  readonly #logger: AsterLogger;
  readonly #remove: () => void;
  readonly #mp4 = new Map<string, { manager: Mp4ExportManager; exportJobId: string }>();
  #taken = false;
  #terminal = false;
  #completing = false;
  #disposed = false;
  #control?: "pause" | "cancel";

  constructor(options: WorkerOptions) {
    this.jobId = options.item.manifest.id;
    this.leaseId = options.leaseId;
    this.#window = options.window;
    this.#item = options.item;
    this.#publisher = options.publisher;
    this.#mediaAuthorization = options.mediaAuthorization;
    this.#report = options.report;
    this.#ffmpegExecutable = options.ffmpegExecutable;
    this.#logger = options.logger;
    this.#remove = options.remove;
  }

  startLoading(options: { appPath: string; developmentUrl: string; packaged: boolean }): void {
    if (this.#disposed) return;
    this.#window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    this.#window.webContents.on("will-navigate", (event, value) => {
      let allowed = false;
      try {
        allowed = options.packaged
          ? value.startsWith(
              `${pathToFileURL(join(options.appPath, "dist", "index.html")).toString()}?`,
            )
          : new URL(value).origin === new URL(options.developmentUrl).origin;
      } catch {
        allowed = false;
      }
      if (!allowed) event.preventDefault();
    });
    this.#window.webContents.once("render-process-gone", (_event, details) => {
      void this.#fail("render_host_crashed", `${details.reason} (${details.exitCode})`);
    });
    this.#window.once("closed", () => {
      this.#remove();
      void this.#fail("render_host_closed", "The hidden RenderHost window closed unexpectedly");
    });
    const loading = options.packaged
      ? this.#window.loadFile(join(options.appPath, "dist", "index.html"), {
          query: { asterRenderHost: "1" },
        })
      : this.#window.loadURL(`${options.developmentUrl}?asterRenderHost=1`);
    void loading.catch((error: unknown) =>
      this.#fail("render_host_load_failed", error instanceof Error ? error.message : String(error)),
    );
  }

  take(): RenderHostAssignment {
    if (this.#taken) throw new Error("RenderHost assignment was already consumed");
    this.#taken = true;
    return {
      jobId: this.jobId,
      leaseId: this.leaseId,
      manifest: structuredClone(this.#item.manifest),
      ...(this.#control ? { initialControl: this.#control } : {}),
    };
  }

  async output(value: unknown): Promise<unknown> {
    if (this.#terminal || this.#disposed) throw new Error("RenderHost output session is closed");
    const request = parseRenderHostOutputRequest(value);
    this.#assertCorrelation(request.jobId, request.leaseId);
    if (request.type === "writePng") {
      await this.#publisher.writePng(request.outputId, request.frame, request.pixels);
      return undefined;
    }
    if (request.type === "startMp4") {
      if (this.#mp4.has(request.outputId)) throw new Error("RenderHost MP4 output already started");
      const output = this.#output(request.outputId, "mp4");
      if (request.audio && !output.includeAudio)
        throw new Error("RenderHost MP4 audio was not enabled by the immutable manifest");
      const manager = new Mp4ExportManager(this.#ffmpegExecutable);
      const started = await manager.start(
        {
          outputPath: this.#publisher.mp4StagingPath(output.id),
          width: this.#item.manifest.width,
          height: this.#item.manifest.height,
          frameRateNumerator: this.#item.manifest.frameRate.numerator,
          frameRateDenominator: this.#item.manifest.frameRate.denominator,
          frameCount: this.#item.manifest.endFrameExclusive - this.#item.manifest.startFrame,
          pixelFormat: request.pixelFormat,
          audio: request.audio,
        },
        this.#window.webContents.id,
      );
      this.#mp4.set(request.outputId, { manager, exportJobId: started.jobId });
      return { encoder: started.encoder };
    }
    const active = this.#mp4.get(request.outputId);
    if (!active) throw new Error("RenderHost MP4 output is not active");
    if (request.type === "writeMp4Frame") {
      await active.manager.write(active.exportJobId, request.pixels, this.#window.webContents.id);
      return undefined;
    }
    if (request.type === "writeMp4Audio") {
      await active.manager.writeAudio(
        active.exportJobId,
        request.samples,
        this.#window.webContents.id,
      );
      return undefined;
    }
    await active.manager.finish(active.exportJobId, this.#window.webContents.id);
    this.#mp4.delete(request.outputId);
    return undefined;
  }

  async hostReport(value: unknown): Promise<void> {
    const report = parseRenderHostReport(value);
    this.#assertCorrelation(report.jobId, report.leaseId);
    if (this.#terminal || this.#completing || this.#disposed)
      throw new Error("RenderHost report session is closed");
    if (report.type === "prepared" || report.type === "progress") {
      await this.#report(report);
      return;
    }
    if (report.type === "completed") {
      this.#completing = true;
      try {
        if (this.#mp4.size > 0) throw new Error("RenderHost completed with unfinished MP4 output");
        await this.#publisher.publish(
          () => this.#control !== undefined || this.#terminal || this.#disposed,
        );
        this.#terminal = true;
        await this.#report({ type: "completed", jobId: this.jobId, leaseId: this.leaseId });
      } catch (error) {
        const externallyTerminated = this.#terminal || this.#disposed;
        this.#terminal = true;
        await this.#cleanup();
        if (externallyTerminated) return;
        if (this.#control)
          await this.#report({
            type: this.#control === "pause" ? "paused" : "cancelled",
            jobId: this.jobId,
            leaseId: this.leaseId,
          });
        else
          await this.#report({
            type: "failed",
            jobId: this.jobId,
            leaseId: this.leaseId,
            error: {
              code: "render_output_publish_failed",
              message: error instanceof Error ? error.message : String(error),
            },
          });
      } finally {
        this.#completing = false;
      }
      return;
    }
    if (report.type === "paused" || report.type === "cancelled" || report.type === "failed") {
      this.#terminal = true;
      await this.#cleanup();
      await this.#report(report);
      return;
    }
    throw new Error("RenderHost report type is invalid");
  }

  control(command: "pause" | "cancel"): void {
    if (this.#terminal || this.#disposed) return;
    this.#control = command === "cancel" ? "cancel" : (this.#control ?? "pause");
    if (!this.#window.webContents.isDestroyed())
      this.#window.webContents.send("aster:render-host-control", {
        jobId: this.jobId,
        leaseId: this.leaseId,
        command: this.#control,
      });
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#terminal = true;
    this.#remove();
    await this.#cleanup();
    if (!this.#window.isDestroyed()) this.#window.destroy();
  }

  async #fail(code: string, message: string): Promise<void> {
    if (this.#terminal || this.#disposed) return;
    this.#terminal = true;
    this.#logger.error("render_host", code, new Error(message), {
      jobId: this.jobId,
      leaseId: this.leaseId,
    });
    await this.#cleanup();
    await this.#report({
      type: "failed",
      jobId: this.jobId,
      leaseId: this.leaseId,
      error: { code, message },
    }).catch(() => undefined);
  }

  async #cleanup(): Promise<void> {
    const managers = [...this.#mp4.values()].map(({ manager }) => manager.dispose());
    this.#mp4.clear();
    await Promise.allSettled(managers);
    await this.#publisher.cleanup();
    this.#mediaAuthorization?.dispose();
  }

  #assertCorrelation(jobId: unknown, leaseId: unknown): void {
    if (jobId !== this.jobId || leaseId !== this.leaseId)
      throw new Error("RenderHost IPC job or lease does not match its hidden window");
  }

  #output<Kind extends RenderOutputModule["kind"]>(
    outputId: string,
    kind: Kind,
  ): Extract<RenderOutputModule, { kind: Kind }> {
    const output = this.#item.manifest.outputs.find((candidate) => candidate.id === outputId);
    if (!output || output.kind !== kind) throw new Error(`RenderHost ${kind} output is invalid`);
    return output as Extract<RenderOutputModule, { kind: Kind }>;
  }
}
