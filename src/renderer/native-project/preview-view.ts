import { projectDocumentWithMediaImports } from "../../core/project/project-file";
import {
  compositionFrameIndex,
  compositionFrameTime,
} from "../../core/rendering/frame-cache-policy";
import {
  type GpuMemoryBudgetMb,
  type GpuMemorySnapshot,
  resolveGpuMemoryBudget,
} from "../../core/rendering/gpu-memory-policy";
import type {
  DesktopNativePreview,
  NativePreviewSnapshot,
} from "../../core/rendering/native-preview-protocol";
import { previewFrameCache } from "../../core/rendering/preview-frame-cache";
import { getSceneGeneratorRegistryRevision } from "../../core/scene/scene-generator-registry";
import type { GpuDiagnostics, Project, RendererMetrics } from "../../core/types";
import { previewFramePlan } from "../frame-cache/cached-beauty-presenter";
import { idleSlot } from "../frame-cache/preview-prerenderer";
import type { RawVideoFrame } from "../gpu/frame-readback";
import type { BeautyFrameRequest } from "../presentation/beauty-frame";
import { NativePreviewCanvas } from "./preview-canvas";
import { previewProjectClosure } from "./preview-project";

export interface NativeViewOptions {
  visualization: string;
  selectedLayerId?: string;
  memoryBudgetMb: number;
  playing: boolean;
}
interface Work {
  request: BeautyFrameRequest;
  options: NativeViewOptions;
}

/** Serial native evaluation with one replaceable foreground request and cancellable idle work. */
export class NativePreviewView {
  #id?: string;
  #project?: Project;
  #key?: string;
  #latest?: Work;
  #pump?: Promise<void>;
  #capturing?: Promise<unknown>;
  #disposed = false;
  #exclusive = false;
  #memoryPreference: GpuMemoryBudgetMb = "auto";
  #epoch = 0;
  #desired?: Work;
  #desiredKey?: string;
  #idleEpoch = 0;
  diagnostics: GpuDiagnostics = {
    available: true,
    adapter: "Rust preview",
    architecture: "native",
    description: "Rust GPU preview",
    maxTextureSize: 16384,
    timestampQueries: false,
  };
  private constructor(
    public canvas: NativePreviewCanvas,
    readonly api: DesktopNativePreview,
    readonly presented: (metrics: RendererMetrics, diagnostics: GpuDiagnostics) => void,
    readonly failed: (error: unknown) => void,
  ) {
    this.diagnostics.gpuMemory = canvas.memory;
  }

  setMemoryBudget(preference: GpuMemoryBudgetMb, memory?: GpuMemorySnapshot): void {
    this.#memoryPreference = preference;
    if (memory?.adapterKey === this.diagnostics.gpuMemory?.adapterKey)
      this.diagnostics.gpuMemory = memory;
  }

  get memoryBudgetMb(): number {
    return resolveGpuMemoryBudget(this.#memoryPreference, this.diagnostics.gpuMemory?.device);
  }

  static async create(
    canvas: HTMLCanvasElement,
    api: DesktopNativePreview,
    presented: (metrics: RendererMetrics, diagnostics: GpuDiagnostics) => void,
    failed: (error: unknown) => void,
  ) {
    return new NativePreviewView(
      await NativePreviewCanvas.create(canvas, api),
      api,
      presented,
      failed,
    );
  }

  queue(request: BeautyFrameRequest, options: NativeViewOptions): void {
    if (this.#disposed) return;
    this.#latest = { request, options };
    this.#desired = this.#latest;
    this.#desiredKey = this.#configuration(this.#latest);
    this.#epoch++;
    this.#idleEpoch++;
    if (this.#pump || this.#capturing || this.#exclusive) return;
    this.#pump = this.#run()
      .catch(this.failed)
      .finally(() => {
        this.#pump = undefined;
        if (this.#latest && !this.#disposed && !this.#exclusive && !this.#capturing)
          this.queue(this.#latest.request, this.#latest.options);
      });
  }

  async #run(): Promise<void> {
    while (this.#latest && !this.#disposed && !this.#exclusive && !this.#capturing) {
      const work = this.#latest;
      this.#latest = undefined;
      const epoch = this.#epoch,
        idleEpoch = this.#idleEpoch,
        key = this.#configuration(work);
      await this.#render(
        work,
        () =>
          !this.#disposed &&
          (this.#epoch === epoch ||
            (work.options.playing &&
              this.#desired?.options.playing === true &&
              this.#desired.request.project === work.request.project &&
              this.#desiredKey === key)),
        true,
      );
      if (!this.#latest && !work.options.playing && work.options.visualization === "beauty")
        await this.#prerender(work, idleEpoch);
    }
  }

  #configuration({ request, options }: Work): string {
    return JSON.stringify([
      request.snapshot,
      request.composition.id,
      request.target,
      request.antiAliasing,
      options.visualization,
      options.selectedLayerId,
      options.memoryBudgetMb,
      getSceneGeneratorRegistryRevision(),
    ]);
  }

  async #ensure({ request, options }: Work): Promise<void> {
    const key = this.#configuration({ request, options });
    if (this.#project === request.project && this.#key === key) return;
    const project = previewProjectClosure(request.project, request.composition.id);
    const document = await projectDocumentWithMediaImports(project, "native");
    const snapshot: NativePreviewSnapshot = {
      ...request.snapshot,
      projectDocument: JSON.stringify(document),
      compositionId: request.composition.id,
      width: request.target.width,
      height: request.target.height,
      time: request.time,
      antiAliasing: request.antiAliasing,
      visualization: options.visualization,
      selectedLayerId: options.selectedLayerId,
      memoryBudgetMb: options.memoryBudgetMb,
      runtimeAssets: project.sources.flatMap((asset) =>
        asset.relativePath && asset.runtimeUrl?.startsWith("aster-asset:")
          ? [{ relativePath: asset.relativePath, url: asset.runtimeUrl }]
          : [],
      ),
    };
    const opened = this.#id
      ? { id: this.#id, ready: await this.api.replace(this.#id, snapshot) }
      : await this.api.open(snapshot);
    this.#id = opened.id;
    if (this.#disposed) {
      await this.api.close(opened.id);
      this.#id = undefined;
      return;
    }
    this.canvas.bind(opened.id, opened.ready);
    this.#key = key;
    this.#project = request.project;
    this.diagnostics = {
      ...this.diagnostics,
      adapter: String(opened.ready.adapter.name ?? "Rust GPU"),
    };
  }

  async #render(work: Work, current: () => boolean, display: boolean): Promise<void> {
    return this.#withRecovery(() => this.#renderFrame(work, current, display), current);
  }

  async #renderFrame(work: Work, current: () => boolean, display: boolean): Promise<void> {
    const started = performance.now();
    await this.#ensure(work);
    if (!current()) return;
    const plan = previewFramePlan(work.request),
      scope = `native:${plan.scope}`;
    const cacheable =
      work.options.visualization === "beauty" &&
      previewFrameCache.enabled &&
      plan.frame >= 0 &&
      (work.options.playing || plan.onFrame);
    if (cacheable) {
      const cached = previewFrameCache.lookup(plan.compositionId, scope, plan.frame);
      if (cached) {
        if (display) {
          await this.canvas.presentCached(cached);
          this.presented(this.#metrics(work, started, 0, 1), this.diagnostics);
        }
        return;
      }
    }
    const result = await this.canvas.present(
      cacheable ? plan.frameTime : work.request.time,
      cacheable,
      current,
      display,
    );
    if (!current() || result.skipped) return;
    if (result.pixels)
      previewFrameCache.store(plan.compositionId, scope, plan.frame, result.pixels);
    if (display)
      this.presented(this.#metrics(work, started, result.render_and_share_ms, 0), this.diagnostics);
  }

  /** Retry a failed transport once; invalid input and pixel-identity failures remain fatal. */
  async #withRecovery<T>(operation: () => Promise<T>, current: () => boolean): Promise<T> {
    let restarted = false;
    if (this.canvas.loss && !this.#disposed) {
      await this.#restart();
      restarted = true;
    }
    try {
      return await operation();
    } catch (error) {
      if (
        restarted ||
        this.#disposed ||
        !current() ||
        (!this.canvas.loss && !/Native preview exited \(|\bEPIPE\b/.test(String(error)))
      )
        throw error;
      await this.#restart();
      if (this.#disposed || !current()) throw error;
      return operation();
    }
  }

  async #restart(): Promise<void> {
    const id = this.#id;
    this.#id = undefined;
    this.#key = undefined;
    this.#project = undefined;
    if (id) {
      try {
        await this.api.close(id);
      } catch (error) {
        // The host retires the private session even when its dead producer rejects shutdown.
        if (!/Native preview exited \(|\bEPIPE\b/.test(String(error))) throw error;
      }
    }
    if (this.canvas.loss && !this.#disposed) {
      const element = this.canvas.canvas;
      this.canvas.dispose();
      const replacement = await NativePreviewCanvas.create(element, this.api);
      if (this.#disposed) {
        replacement.dispose();
        throw new Error("Native preview closed during device recovery");
      }
      this.canvas = replacement;
      this.diagnostics.gpuMemory = replacement.memory;
    }
  }

  #metrics(work: Work, started: number, nativeMs: number, cacheHitRate: number): RendererMetrics {
    const elapsed = performance.now() - started;
    const metrics: RendererMetrics = {
      fps: 1000 / Math.max(0.001, elapsed),
      frameMs: elapsed,
      cpuMs: nativeMs,
      drawCalls: 0,
      passCount: 0,
      dirtyNodes: 0,
      cacheHitRate,
      estimatedVramMb: (work.request.target.width * work.request.target.height * 12) / 1048576,
      transientTextureCount: 3,
      memoryBudgetMb: work.options.memoryBudgetMb,
    };
    return metrics;
  }

  /** The exclusive editor benchmark measures evaluation and GPU presentation without RAM hits. */
  async presentUncached(
    request: BeautyFrameRequest,
    memoryBudgetMb: number,
  ): Promise<RendererMetrics> {
    if (this.#disposed || this.#capturing) throw new Error("Native preview is closed or capturing");
    this.stopIdle();
    await this.#pump;
    const started = performance.now();
    const work = { request, options: { visualization: "beauty", memoryBudgetMb, playing: false } };
    const result = await this.#withRecovery(
      async () => {
        await this.#ensure(work);
        return this.canvas.present(request.time, false, () => !this.#disposed, true);
      },
      () => !this.#disposed,
    );
    if (result.skipped) throw new Error("Native benchmark presentation cancelled");
    // Match the TS benchmark: return metrics without publishing editor UI or mirror updates.
    return this.#metrics(work, started, result.render_and_share_ms, 0);
  }

  async beginExclusive(): Promise<void> {
    if (this.#disposed || this.#capturing || this.#exclusive)
      throw new Error("Native preview cannot enter an exclusive session");
    this.#exclusive = true;
    this.#latest = undefined;
    this.#epoch++;
    this.stopIdle();
    await this.#pump;
  }

  endExclusive(): void {
    this.#exclusive = false;
    if (this.#latest && !this.#disposed) this.queue(this.#latest.request, this.#latest.options);
  }

  async #prerender(work: Work, epoch: number): Promise<void> {
    if (!previewFrameCache.enabled) return;
    const plan = previewFramePlan(work.request);
    if (!plan.onFrame) return;
    const current = () =>
      !this.#disposed && !this.#exclusive && !this.#latest && epoch === this.#idleEpoch;
    const rate = work.request.composition.frameRate,
      area = work.request.composition.workArea;
    const first = Math.max(0, compositionFrameIndex(area.start, rate));
    const last = Math.max(
      first,
      Math.ceil((area.end * rate.numerator) / rate.denominator - 1e-6) - 1,
    );
    let remaining =
      Math.floor(
        previewFrameCache.usage().budgetBytes /
          (work.request.target.width * work.request.target.height * 4),
      ) - 2;
    // Iterate only the budgeted window; a long composition must not allocate its full frame list.
    const tailStart = Math.max(first, plan.frame + 1);
    const tailCount = Math.max(0, last - tailStart + 1);
    const headCount = Math.max(0, Math.min(plan.frame, last + 1) - first);
    for (let index = 0; index < tailCount + headCount && remaining-- > 0; index++) {
      if (!current()) return;
      const frame = index < tailCount ? tailStart + index : first + index - tailCount;
      await idleSlot();
      if (!current()) return;
      await this.#render(
        { ...work, request: { ...work.request, time: compositionFrameTime(frame, rate) } },
        current,
        false,
      );
    }
  }

  readback(
    request: BeautyFrameRequest,
    memoryBudgetMb: number,
    destination?: ArrayBuffer,
  ): Promise<RawVideoFrame> {
    return this.#capture(async () => {
      const result = await this.#withRecovery(
        async () => {
          await this.#ensure({
            request,
            options: { visualization: "beauty", memoryBudgetMb, playing: false },
          });
          return this.canvas.present(request.time, true, () => !this.#disposed, false);
        },
        () => !this.#disposed,
      );
      if (!result.pixels || result.skipped) throw new Error("Native readback was cancelled");
      const pixels = result.pixels;
      if (destination) {
        if (destination.byteLength !== pixels.pixels.byteLength)
          throw new Error("Native readback destination size differs");
        new Uint8Array(destination).set(new Uint8Array(pixels.pixels));
        return { pixels: destination, pixelFormat: pixels.pixelFormat };
      }
      return { pixels: pixels.pixels, pixelFormat: pixels.pixelFormat };
    });
  }

  /** Capture the requested diagnostic or beauty frame without reading or replacing the viewport. */
  snapshot(request: BeautyFrameRequest, options: NativeViewOptions): Promise<HTMLCanvasElement> {
    return this.#capture(async () => {
      const target = document.createElement("canvas");
      try {
        const current = () => !this.#disposed;
        const result = await this.#withRecovery(async () => {
          await this.#ensure({ request, options });
          return this.canvas.present(request.time, false, current, false, target);
        }, current);
        if (result.skipped || !current()) throw new Error("Native snapshot was cancelled");
        return target;
      } catch (error) {
        target.width = 0;
        target.height = 0;
        throw error;
      }
    });
  }

  #capture<T>(operation: () => Promise<T>): Promise<T> {
    if (this.#disposed || this.#capturing || this.#exclusive)
      return Promise.reject(new Error("Native capture is closed or busy"));
    this.stopIdle();
    const pending = (async () => {
      await this.#pump;
      if (this.#disposed) throw new Error("Native preview is closed");
      return operation();
    })().finally(() => {
      this.#capturing = undefined;
      if (this.#latest && !this.#disposed) this.queue(this.#latest.request, this.#latest.options);
    });
    this.#capturing = pending;
    return pending;
  }

  async settled(): Promise<void> {
    await this.#pump;
  }

  stopIdle(): void {
    this.#idleEpoch++;
  }

  async dispose(): Promise<void> {
    this.#disposed = true;
    this.#latest = undefined;
    this.#epoch++;
    this.#idleEpoch++;
    await this.#pump;
    await this.#capturing?.catch(() => undefined);
    this.canvas.dispose();
    if (this.#id) {
      const id = this.#id;
      this.#id = undefined;
      await this.api.close(id);
    }
  }
}
